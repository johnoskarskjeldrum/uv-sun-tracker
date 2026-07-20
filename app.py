"""
Sol-tracker backend (FastAPI + SQLite).

En liten, adaptiv sol-tracker som:
  - Henter live UV-indeks fra Open-Meteo basert paa posisjon.
  - Beregner akkumulert UV-dose (SED) for hver solingsoekt.
  - Laerer brukerens faktiske taalegrense (MED_cal) over tid via feedback.

Kjoer lokalt:   uvicorn app:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).parent
DB_PATH = BASE_DIR / "soldata.db"
STATIC_DIR = BASE_DIR / "static"

# Hvor lenge etter en oekt vi begynner aa be om hud-feedback (rodhet kommer 4-24t etter).
FEEDBACK_DELAY_HOURS = 8

# Laeringsrate for nedjustering ved solbrenthet.
ALPHA = 0.3
# Nedre grense slik at MED_cal aldri kollapser til 0.
MED_FLOOR = 0.5

# Skydekke demper UV-straalingen. Faktor som ganges inn i dosen.
CLOUD_FACTOR = {
    "clear": 1.0,      # Full sol
    "partly": 0.7,     # Noe skyer
    "overcast": 0.4,   # Helt overskyet
}

# Standard start-MED (SED) per Fitzpatrick-hudtype.
FITZPATRICK_MED = {
    1: 2.0,   # Type I  - alltid solbrent, aldri brun
    2: 2.5,   # Type II - lett solbrent, blir saavidt brun
    3: 3.5,   # Type III - av og til solbrent, blir gradvis brun
    4: 4.5,   # Type IV - sjelden solbrent, blir lett brun
    5: 6.0,   # Type V  - svaert sjelden solbrent, moerk hud
    6: 10.0,  # Type VI - aldri solbrent, svaert moerk hud
}

app = FastAPI(title="Sol-tracker")


# --------------------------------------------------------------------------
# Database
# --------------------------------------------------------------------------
@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS profile (
                id           INTEGER PRIMARY KEY CHECK (id = 1),
                fitzpatrick  INTEGER NOT NULL,
                initial_med  REAL NOT NULL,
                med_cal      REAL NOT NULL,
                default_lat  REAL,
                default_lon  REAL,
                created_at   TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                start_time       TEXT NOT NULL,
                end_time         TEXT NOT NULL,
                local_date       TEXT,            -- lokal kalenderdato YYYY-MM-DD
                uv_index         REAL NOT NULL,
                spf              INTEGER NOT NULL,
                thickness        TEXT NOT NULL,   -- none | thin | thick
                cloud            TEXT NOT NULL DEFAULT 'clear',   -- clear | partly | overcast
                body_side        TEXT NOT NULL DEFAULT 'both',    -- front | back | both
                calculated_dose  REAL NOT NULL,
                feedback         TEXT,            -- (utfaset: feedback ligger naa paa dag-nivaa)
                feedback_time    TEXT,
                feedback_comment TEXT,
                burn_location    TEXT,
                created_at       TEXT NOT NULL
            );

            -- Feedback og laering skjer paa dag-nivaa: solbrenthet skyldes
            -- dagens SAMLEDE dose, ikke en enkelt oekt.
            CREATE TABLE IF NOT EXISTS days (
                date             TEXT PRIMARY KEY,   -- lokal kalenderdato YYYY-MM-DD
                feedback         TEXT,               -- green | yellow | red
                feedback_time    TEXT,
                feedback_comment TEXT,
                burn_location    TEXT,
                learned          INTEGER NOT NULL DEFAULT 0
            );
            """
        )


SEVERITY = {"green": 1, "yellow": 2, "red": 3}


def migrate() -> None:
    """Legg til nye kolonner paa eksisterende databaser (f.eks. paa Pi-en)."""
    with db() as conn:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(sessions)")}
        alters = {
            "cloud": "ALTER TABLE sessions ADD COLUMN cloud TEXT NOT NULL DEFAULT 'clear'",
            "body_side": "ALTER TABLE sessions ADD COLUMN body_side TEXT NOT NULL DEFAULT 'both'",
            "feedback_comment": "ALTER TABLE sessions ADD COLUMN feedback_comment TEXT",
            "burn_location": "ALTER TABLE sessions ADD COLUMN burn_location TEXT",
            "local_date": "ALTER TABLE sessions ADD COLUMN local_date TEXT",
        }
        for col, sql in alters.items():
            if col not in cols:
                conn.execute(sql)

        # Backfill lokal dato for gamle oekter (best effort: UTC-dato fra starttid).
        conn.execute(
            "UPDATE sessions SET local_date = substr(start_time, 1, 10) WHERE local_date IS NULL"
        )

        # Migrer eksisterende oekt-feedback opp til dag-nivaa (kun for dager som
        # ikke allerede har et dag-innslag). Laering ble alt brukt per oekt, saa
        # vi markerer disse dagene som 'learned' for aa unngaa dobbel justering.
        rows = conn.execute(
            """SELECT local_date, feedback, feedback_time, feedback_comment, burn_location
               FROM sessions WHERE feedback IS NOT NULL ORDER BY feedback_time"""
        ).fetchall()
        by_date: dict[str, dict] = {}
        for r in rows:
            d = by_date.setdefault(r["local_date"], {
                "feedback": None, "feedback_time": r["feedback_time"],
                "comments": [], "burns": [],
            })
            # Behold den mest alvorlige tilbakemeldingen for dagen.
            if d["feedback"] is None or SEVERITY[r["feedback"]] > SEVERITY[d["feedback"]]:
                d["feedback"] = r["feedback"]
            d["feedback_time"] = r["feedback_time"] or d["feedback_time"]
            if r["feedback_comment"]:
                d["comments"].append(r["feedback_comment"])
            if r["burn_location"]:
                d["burns"].append(r["burn_location"])
        for date, d in by_date.items():
            exists = conn.execute("SELECT 1 FROM days WHERE date = ?", (date,)).fetchone()
            if exists:
                continue
            conn.execute(
                """INSERT INTO days (date, feedback, feedback_time, feedback_comment, burn_location, learned)
                   VALUES (?, ?, ?, ?, ?, 1)""",
                (date, d["feedback"], d["feedback_time"],
                 "; ".join(d["comments"]) or None,
                 ", ".join(sorted(set(", ".join(d["burns"]).split(", ")))) if d["burns"] else None),
            )


init_db()
migrate()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_iso(value: str) -> datetime:
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


# --------------------------------------------------------------------------
# Beregningslogikk
# --------------------------------------------------------------------------
def effective_spf(spf: int, thickness: str) -> float:
    """Realistisk effektiv SPF. Folk smoerer for tynt, saa vi halverer ved 'thin'."""
    if thickness == "none" or spf <= 1:
        return 1.0
    if thickness == "thin":
        return max(1.0, spf / 2)
    return float(spf)  # thick


def compute_dose(start: datetime, end: datetime, uv_index: float, spf: int,
                 thickness: str, cloud: str = "clear") -> float:
    """Dose (SED) = UV-indeks * (minutter/60) * 0.9 * skyfaktor / effektiv_SPF."""
    minutes = max(0.0, (end - start).total_seconds() / 60.0)
    cloud_factor = CLOUD_FACTOR.get(cloud, 1.0)
    return uv_index * (minutes / 60.0) * 0.9 * cloud_factor / effective_spf(spf, thickness)


def apply_learning(med_cal: float, dose: float, feedback: str) -> float:
    """Juster brukerens taalegrense basert paa feedback."""
    if feedback == "red":
        # Ble solbrent: dosen var over det huden taalte -> juster ned mot dosen.
        if dose < med_cal:
            med_cal = med_cal - (med_cal - dose) * ALPHA
    elif feedback == "yellow":
        # Naesten brent: taalegrensen ligger rundt denne dosen -> forsiktig ned.
        if dose < med_cal:
            med_cal = med_cal - (med_cal - dose) * (ALPHA / 2)
    elif feedback == "green":
        # Ikke brent selv om dosen var over antatt grense -> taaler mer, juster forsiktig opp.
        if dose > med_cal:
            med_cal = med_cal + 0.2
    return round(max(MED_FLOOR, med_cal), 3)


# --------------------------------------------------------------------------
# API-modeller
# --------------------------------------------------------------------------
class ProfileIn(BaseModel):
    fitzpatrick: int = Field(ge=1, le=6)
    default_lat: float | None = None
    default_lon: float | None = None


class SessionIn(BaseModel):
    start_time: str
    end_time: str
    local_date: str | None = None              # lokal dato YYYY-MM-DD (settes av frontend)
    uv_index: float = Field(ge=0)
    spf: int = Field(ge=1, default=1)
    thickness: str = Field(default="none")     # none | thin | thick
    cloud: str = Field(default="clear")        # clear | partly | overcast
    body_side: str = Field(default="both")     # front | back | both


class FeedbackIn(BaseModel):
    date: str  # lokal kalenderdato YYYY-MM-DD
    feedback: str  # green | yellow | red
    comment: str | None = None
    burn_location: str | None = None


# --------------------------------------------------------------------------
# Profil
# --------------------------------------------------------------------------
@app.get("/api/profile")
def get_profile():
    with db() as conn:
        row = conn.execute("SELECT * FROM profile WHERE id = 1").fetchone()
    return dict(row) if row else None


@app.post("/api/profile")
def set_profile(data: ProfileIn):
    initial = FITZPATRICK_MED[data.fitzpatrick]
    with db() as conn:
        existing = conn.execute("SELECT * FROM profile WHERE id = 1").fetchone()
        if existing:
            # Behold kalibrert grense hvis hudtypen er uendret; ellers nullstill.
            med_cal = existing["med_cal"] if existing["fitzpatrick"] == data.fitzpatrick else initial
            conn.execute(
                """UPDATE profile
                   SET fitzpatrick=?, initial_med=?, med_cal=?, default_lat=?, default_lon=?
                   WHERE id = 1""",
                (data.fitzpatrick, initial, med_cal, data.default_lat, data.default_lon),
            )
        else:
            conn.execute(
                """INSERT INTO profile
                   (id, fitzpatrick, initial_med, med_cal, default_lat, default_lon, created_at)
                   VALUES (1, ?, ?, ?, ?, ?, ?)""",
                (data.fitzpatrick, initial, initial, data.default_lat, data.default_lon, now_iso()),
            )
        row = conn.execute("SELECT * FROM profile WHERE id = 1").fetchone()
    return dict(row)


# --------------------------------------------------------------------------
# UV-indeks (Open-Meteo)
# --------------------------------------------------------------------------
@app.get("/api/uv")
async def get_uv(lat: float, lon: float):
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": lat,
        "longitude": lon,
        "current": "uv_index",
        "daily": "uv_index_max",
        "timezone": "auto",
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail=f"Kunne ikke hente UV-data: {exc}")

    current = (data.get("current") or {}).get("uv_index")
    daily_max = (data.get("daily") or {}).get("uv_index_max") or []
    return {
        "uv_index": current,
        "uv_index_max_today": daily_max[0] if daily_max else None,
    }


# --------------------------------------------------------------------------
# Oekter
# --------------------------------------------------------------------------
@app.post("/api/session")
def create_session(data: SessionIn):
    start = parse_iso(data.start_time)
    end = parse_iso(data.end_time)
    if end < start:
        raise HTTPException(status_code=400, detail="Sluttid er foer starttid.")
    dose = round(compute_dose(start, end, data.uv_index, data.spf, data.thickness, data.cloud), 3)
    local_date = data.local_date or data.start_time[:10]
    with db() as conn:
        cur = conn.execute(
            """INSERT INTO sessions
               (start_time, end_time, local_date, uv_index, spf, thickness, cloud, body_side,
                calculated_dose, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (data.start_time, data.end_time, local_date, data.uv_index, data.spf,
             data.thickness, data.cloud, data.body_side, dose, now_iso()),
        )
        row = conn.execute("SELECT * FROM sessions WHERE id = ?", (cur.lastrowid,)).fetchone()
    return dict(row)


@app.put("/api/session/{session_id}")
def update_session(session_id: int, data: SessionIn):
    """Rediger en tidligere oekt (f.eks. rette sluttid hvis du glemte aa stoppe)."""
    start = parse_iso(data.start_time)
    end = parse_iso(data.end_time)
    if end < start:
        raise HTTPException(status_code=400, detail="Sluttid er foer starttid.")
    dose = round(compute_dose(start, end, data.uv_index, data.spf, data.thickness, data.cloud), 3)
    local_date = data.local_date or data.start_time[:10]
    with db() as conn:
        if not conn.execute("SELECT 1 FROM sessions WHERE id = ?", (session_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Fant ikke oekten.")
        conn.execute(
            """UPDATE sessions
               SET start_time=?, end_time=?, local_date=?, uv_index=?, spf=?, thickness=?,
                   cloud=?, body_side=?, calculated_dose=?
               WHERE id=?""",
            (data.start_time, data.end_time, local_date, data.uv_index, data.spf, data.thickness,
             data.cloud, data.body_side, dose, session_id),
        )
        row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    return dict(row)


@app.delete("/api/session/{session_id}")
def delete_session(session_id: int):
    with db() as conn:
        cur = conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Fant ikke oekten.")
    return {"deleted": session_id}


@app.get("/api/sessions")
def list_sessions():
    with db() as conn:
        rows = conn.execute("SELECT * FROM sessions ORDER BY start_time DESC").fetchall()
    return [dict(r) for r in rows]


def _days_query(conn):
    """Aggreger oekter til dager, med dagssum og dag-feedback + oektene under."""
    sessions = conn.execute("SELECT * FROM sessions ORDER BY start_time DESC").fetchall()
    day_rows = {r["date"]: dict(r) for r in conn.execute("SELECT * FROM days").fetchall()}
    days: dict[str, dict] = {}
    for s in sessions:
        date = s["local_date"] or s["start_time"][:10]
        day = days.setdefault(date, {
            "date": date, "total_dose": 0.0, "sessions": [],
            "feedback": None, "feedback_time": None,
            "feedback_comment": None, "burn_location": None, "last_end": None,
        })
        day["total_dose"] = round(day["total_dose"] + s["calculated_dose"], 3)
        day["sessions"].append(dict(s))
        if day["last_end"] is None or s["end_time"] > day["last_end"]:
            day["last_end"] = s["end_time"]
    for date, day in days.items():
        if date in day_rows:
            fb = day_rows[date]
            day["feedback"] = fb["feedback"]
            day["feedback_time"] = fb["feedback_time"]
            day["feedback_comment"] = fb["feedback_comment"]
            day["burn_location"] = fb["burn_location"]
    return sorted(days.values(), key=lambda d: d["date"], reverse=True)


@app.get("/api/days")
def list_days():
    with db() as conn:
        return _days_query(conn)


@app.get("/api/pending-feedback")
def pending_feedback():
    """Dager uten feedback der det har gaatt lenge nok til at rodhet ville vist seg."""
    now = datetime.now(timezone.utc)
    with db() as conn:
        days = _days_query(conn)
    due = []
    for day in days:
        if day["feedback"] is not None or not day["last_end"]:
            continue
        hours = (now - parse_iso(day["last_end"])).total_seconds() / 3600.0
        if hours >= FEEDBACK_DELAY_HOURS:
            due.append({"date": day["date"], "total_dose": day["total_dose"]})
    return due


@app.post("/api/feedback")
def submit_feedback(data: FeedbackIn):
    """Feedback for en hel dag. Laeringen bruker dagens SAMLEDE dose."""
    if data.feedback not in ("green", "yellow", "red"):
        raise HTTPException(status_code=400, detail="Ugyldig feedback-verdi.")
    with db() as conn:
        profile = conn.execute("SELECT * FROM profile WHERE id = 1").fetchone()
        if not profile:
            raise HTTPException(status_code=400, detail="Ingen profil er satt opp.")
        total = conn.execute(
            "SELECT COALESCE(SUM(calculated_dose), 0) AS d FROM sessions WHERE local_date = ?",
            (data.date,),
        ).fetchone()["d"]

        existing = conn.execute("SELECT * FROM days WHERE date = ?", (data.date,)).fetchone()
        old_med = profile["med_cal"]
        new_med = old_med
        # Laer bare én gang per dag (unngaa dobbel-justering).
        if not existing or existing["learned"] == 0:
            new_med = apply_learning(old_med, round(total, 3), data.feedback)
            conn.execute("UPDATE profile SET med_cal = ? WHERE id = 1", (new_med,))

        if existing:
            conn.execute(
                """UPDATE days SET feedback=?, feedback_time=?, feedback_comment=?,
                       burn_location=?, learned=1 WHERE date=?""",
                (data.feedback, now_iso(), data.comment, data.burn_location, data.date),
            )
        else:
            conn.execute(
                """INSERT INTO days (date, feedback, feedback_time, feedback_comment, burn_location, learned)
                   VALUES (?, ?, ?, ?, ?, 1)""",
                (data.date, data.feedback, now_iso(), data.comment, data.burn_location),
            )
    return {"old_med_cal": old_med, "new_med_cal": new_med, "delta": round(new_med - old_med, 3),
            "total_dose": round(total, 3)}


# --------------------------------------------------------------------------
# Dagens status
# --------------------------------------------------------------------------
@app.get("/api/today")
def today_status(date: str | None = None):
    """Sum av dagens doser + prosent av kalibrert taalegrense.

    `date` er brukerens lokale dato (YYYY-MM-DD); faller tilbake til UTC-dato.
    """
    day = date or datetime.now(timezone.utc).date().isoformat()
    with db() as conn:
        profile = conn.execute("SELECT * FROM profile WHERE id = 1").fetchone()
        rows = conn.execute(
            "SELECT calculated_dose FROM sessions WHERE local_date = ?",
            (day,),
        ).fetchall()
    dose_today = round(sum(r["calculated_dose"] for r in rows), 3)
    med_cal = profile["med_cal"] if profile else None
    percent = round(dose_today / med_cal * 100, 1) if med_cal else None
    return {"dose_today": dose_today, "med_cal": med_cal, "percent_of_med": percent}


# --------------------------------------------------------------------------
# Statiske filer / PWA
# --------------------------------------------------------------------------
@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/", StaticFiles(directory=STATIC_DIR), name="static")
