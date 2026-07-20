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
                uv_index         REAL NOT NULL,
                spf              INTEGER NOT NULL,
                thickness        TEXT NOT NULL,   -- none | thin | thick
                cloud            TEXT NOT NULL DEFAULT 'clear',   -- clear | partly | overcast
                body_side        TEXT NOT NULL DEFAULT 'both',    -- front | back | both
                calculated_dose  REAL NOT NULL,
                feedback         TEXT,            -- green | yellow | red  (NULL = ubesvart)
                feedback_time    TEXT,
                feedback_comment TEXT,
                burn_location    TEXT,
                created_at       TEXT NOT NULL
            );
            """
        )


def migrate() -> None:
    """Legg til nye kolonner paa eksisterende databaser (f.eks. paa Pi-en)."""
    with db() as conn:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(sessions)")}
        alters = {
            "cloud": "ALTER TABLE sessions ADD COLUMN cloud TEXT NOT NULL DEFAULT 'clear'",
            "body_side": "ALTER TABLE sessions ADD COLUMN body_side TEXT NOT NULL DEFAULT 'both'",
            "feedback_comment": "ALTER TABLE sessions ADD COLUMN feedback_comment TEXT",
            "burn_location": "ALTER TABLE sessions ADD COLUMN burn_location TEXT",
        }
        for col, sql in alters.items():
            if col not in cols:
                conn.execute(sql)


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
    uv_index: float = Field(ge=0)
    spf: int = Field(ge=1, default=1)
    thickness: str = Field(default="none")     # none | thin | thick
    cloud: str = Field(default="clear")        # clear | partly | overcast
    body_side: str = Field(default="both")     # front | back | both


class FeedbackIn(BaseModel):
    session_id: int
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
    with db() as conn:
        cur = conn.execute(
            """INSERT INTO sessions
               (start_time, end_time, uv_index, spf, thickness, cloud, body_side,
                calculated_dose, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (data.start_time, data.end_time, data.uv_index, data.spf,
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
    with db() as conn:
        if not conn.execute("SELECT 1 FROM sessions WHERE id = ?", (session_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Fant ikke oekten.")
        conn.execute(
            """UPDATE sessions
               SET start_time=?, end_time=?, uv_index=?, spf=?, thickness=?,
                   cloud=?, body_side=?, calculated_dose=?
               WHERE id=?""",
            (data.start_time, data.end_time, data.uv_index, data.spf, data.thickness,
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


@app.get("/api/pending-feedback")
def pending_feedback():
    """Oekter uten feedback der det har gaatt lenge nok til at rodhet ville vist seg."""
    now = datetime.now(timezone.utc)
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM sessions WHERE feedback IS NULL ORDER BY start_time DESC"
        ).fetchall()
    due = []
    for r in rows:
        hours = (now - parse_iso(r["end_time"])).total_seconds() / 3600.0
        if hours >= FEEDBACK_DELAY_HOURS:
            due.append(dict(r))
    return due


@app.post("/api/feedback")
def submit_feedback(data: FeedbackIn):
    if data.feedback not in ("green", "yellow", "red"):
        raise HTTPException(status_code=400, detail="Ugyldig feedback-verdi.")
    with db() as conn:
        session = conn.execute(
            "SELECT * FROM sessions WHERE id = ?", (data.session_id,)
        ).fetchone()
        if not session:
            raise HTTPException(status_code=404, detail="Fant ikke oekten.")
        profile = conn.execute("SELECT * FROM profile WHERE id = 1").fetchone()
        if not profile:
            raise HTTPException(status_code=400, detail="Ingen profil er satt opp.")

        old_med = profile["med_cal"]
        # Bare laer av oekter som ikke allerede er besvart (unngaa dobbel-justering).
        new_med = old_med
        if session["feedback"] is None:
            new_med = apply_learning(old_med, session["calculated_dose"], data.feedback)
            conn.execute("UPDATE profile SET med_cal = ? WHERE id = 1", (new_med,))

        conn.execute(
            """UPDATE sessions
               SET feedback = ?, feedback_time = ?, feedback_comment = ?, burn_location = ?
               WHERE id = ?""",
            (data.feedback, now_iso(), data.comment, data.burn_location, data.session_id),
        )
    return {"old_med_cal": old_med, "new_med_cal": new_med, "delta": round(new_med - old_med, 3)}


# --------------------------------------------------------------------------
# Dagens status
# --------------------------------------------------------------------------
@app.get("/api/today")
def today_status():
    """Sum av dagens doser + prosent av kalibrert taalegrense."""
    today = datetime.now(timezone.utc).date().isoformat()
    with db() as conn:
        profile = conn.execute("SELECT * FROM profile WHERE id = 1").fetchone()
        rows = conn.execute(
            "SELECT calculated_dose, start_time FROM sessions WHERE start_time >= ?",
            (today,),
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
