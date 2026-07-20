// ---------------------------------------------------------------------------
// Sol-tracker frontend
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const api = async (path, opts) => {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
  return res.status === 204 ? null : res.json();
};

const FITZ = [
  { type: 1, color: "#f4d0b0", name: "Type I", desc: "Alltid solbrent, aldri brun" },
  { type: 2, color: "#eec3a0", name: "Type II", desc: "Lett solbrent, blir så vidt brun" },
  { type: 3, color: "#d8a878", name: "Type III", desc: "Av og til brent, gradvis brun" },
  { type: 4, color: "#b07d4f", name: "Type IV", desc: "Sjelden brent, blir lett brun" },
  { type: 5, color: "#7a5233", name: "Type V", desc: "Svært sjelden brent, mørk hud" },
  { type: 6, color: "#4a2f1c", name: "Type VI", desc: "Aldri brent, svært mørk hud" },
];

const CLOUD_FACTOR = { clear: 1.0, partly: 0.7, overcast: 0.4 };
const CLOUD_LABEL = { clear: "☀️ Full sol", partly: "⛅ Noe skyer", overcast: "☁️ Overskyet" };
const SIDE_LABEL = { both: "Begge sider", front: "Forside", back: "Bakside" };
const BURN_PARTS = ["Ansikt", "Nakke/hals", "Skuldre", "Rygg", "Bryst/mage", "Armer", "Ben", "Føtter"];

const ACTIVE_KEY = "solActiveSession";

const state = {
  profile: null,
  uv: null,
  running: false,
  startTime: null,
  tickHandle: null,
  selectedFitz: null,
  selectedFeedback: null,
  wakeLock: null,
  _baseDose: 0,
};

// ---------------------------------------------------------------------------
// Hjelpere
// ---------------------------------------------------------------------------
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), 3200);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function show(screen) {
  ["onboarding", "home", "settings"].forEach((s) => $("#" + s).classList.add("hidden"));
  $("#" + screen).classList.remove("hidden");
}

function fmtDuration(sec) {
  const h = String(Math.floor(sec / 3600)).padStart(2, "0");
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
  const s = String(Math.floor(sec % 60)).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("no", { day: "numeric", month: "short" }) +
    " " + d.toLocaleTimeString("no", { hour: "2-digit", minute: "2-digit" });
}

// datetime-local <-> Date
function toLocalInput(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Lokal kalenderdato (YYYY-MM-DD) — brukes til å gruppere økter per dag.
function localDateStr(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDay(dateStr) {
  const today = localDateStr(new Date());
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (dateStr === today) return "I dag";
  if (dateStr === localDateStr(y)) return "I går";
  return new Date(dateStr + "T12:00:00").toLocaleDateString("no",
    { weekday: "short", day: "numeric", month: "short" });
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString("no", { hour: "2-digit", minute: "2-digit" });
}

// Samme doseformel som backend, for sanntidsvisning mens timeren går.
function effectiveSpf(spf, thickness) {
  if (thickness === "none" || spf <= 1) return 1;
  if (thickness === "thin") return Math.max(1, spf / 2);
  return spf;
}
function computeDose(minutes, uv, spf, thickness, cloud) {
  return (uv * (minutes / 60) * 0.9 * (CLOUD_FACTOR[cloud] ?? 1)) / effectiveSpf(spf, thickness);
}

function doseColor(pct) {
  if (pct < 60) return "linear-gradient(90deg,#34c759,#a8e05f)";
  if (pct < 100) return "linear-gradient(90deg,#ffcc00,#ff9500)";
  return "linear-gradient(90deg,#ff5252,#d32f2f)";
}

// ---------------------------------------------------------------------------
// Aktiv økt (localStorage) — overlever at mobilnettleseren kaster fanen
// ---------------------------------------------------------------------------
function saveActive(obj) { localStorage.setItem(ACTIVE_KEY, JSON.stringify(obj)); }
function loadActive() { try { return JSON.parse(localStorage.getItem(ACTIVE_KEY)); } catch { return null; } }
function clearActive() { localStorage.removeItem(ACTIVE_KEY); }

// Wake Lock: holder skjermen våken så fanen ikke kastes mens du soler.
async function acquireWakeLock() {
  try {
    if ("wakeLock" in navigator && !state.wakeLock) {
      state.wakeLock = await navigator.wakeLock.request("screen");
      state.wakeLock.addEventListener("release", () => (state.wakeLock = null));
    }
  } catch { /* ignoreres (ikke støttet / nektet) */ }
}
function releaseWakeLock() {
  try { state.wakeLock?.release(); } catch {}
  state.wakeLock = null;
}

// ---------------------------------------------------------------------------
// Fitzpatrick-velger (gjenbrukt i onboarding + innstillinger)
// ---------------------------------------------------------------------------
function renderFitzList(container, selected, onSelect) {
  container.innerHTML = "";
  FITZ.forEach((f) => {
    const el = document.createElement("div");
    el.className = "fitz-item" + (f.type === selected ? " active" : "");
    el.innerHTML = `
      <div class="fitz-swatch" style="background:${f.color}"></div>
      <div class="fitz-text"><b>${f.name}</b><small>${f.desc}</small></div>`;
    el.onclick = () => {
      container.querySelectorAll(".fitz-item").forEach((x) => x.classList.remove("active"));
      el.classList.add("active");
      onSelect(f.type);
    };
    container.appendChild(el);
  });
}

// ---------------------------------------------------------------------------
// UV-henting: prøv GPS, fall tilbake til lagret hjemmeposisjon
// ---------------------------------------------------------------------------
function getPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 8000, maximumAge: 600000 }
    );
  });
}

async function loadUv() {
  let coords = await getPosition();
  if (!coords && state.profile?.default_lat != null) {
    coords = { lat: state.profile.default_lat, lon: state.profile.default_lon };
  }
  if (!coords) {
    $("#uv-value").textContent = "?";
    $("#uv-sub").textContent = "Sett hjemmeposisjon i ⚙️";
    return;
  }
  try {
    const data = await api(`/api/uv?lat=${coords.lat}&lon=${coords.lon}`);
    state.uv = data.uv_index ?? 0;
    $("#uv-value").textContent = state.uv?.toFixed(1) ?? "?";
    $("#uv-sub").textContent = data.uv_index_max_today != null
      ? `Maks i dag: ${data.uv_index_max_today.toFixed(1)}` : "";
  } catch (e) {
    $("#uv-value").textContent = "?";
    $("#uv-sub").textContent = "UV-data utilgjengelig";
  }
}

// ---------------------------------------------------------------------------
// Dagens status + historikk
// ---------------------------------------------------------------------------
async function refreshHome() {
  $("#med-value").textContent = state.profile.med_cal.toFixed(1);
  // Under aktiv soling styrer tick() dose-panelet — ikke overskriv det her.
  if (!state.running) {
    await loadUv();
    await refreshDose();
  }
  await refreshHistory();
  await checkPendingFeedback();
}

async function refreshDose() {
  const t = await api("/api/today?date=" + localDateStr(new Date()));
  updateDosePanel(t.dose_today, t.med_cal);
}

function updateDosePanel(dose, medCal) {
  const pct = medCal ? (dose / medCal) * 100 : 0;
  $("#dose-percent").textContent = Math.round(pct) + " %";
  const bar = $("#dose-bar");
  bar.style.width = Math.min(100, pct) + "%";
  bar.style.background = doseColor(pct);
  $("#dose-detail").textContent = `${dose.toFixed(2)} av ${medCal.toFixed(1)} SED`;
}

async function refreshHistory() {
  const days = await api("/api/days");
  state.sessionsById = {};
  const box = $("#history");
  box.innerHTML = "";
  if (!days.length) {
    box.innerHTML = `<p class="hint">Ingen økter ennå. Trykk «Start soling» for å begynne.</p>`;
    return;
  }
  days.forEach((day) => {
    // Dag-overskrift med samlet dose og dag-feedback.
    const dot = day.feedback ? `<div class="hist-dot dot-${day.feedback}"></div>` : "";
    const fbBtn = day.feedback ? "" :
      `<button class="hist-fb-btn" data-date="${day.date}" data-dose="${day.total_dose}">Gi feedback</button>`;
    const noteParts = [];
    if (day.burn_location) noteParts.push(`Brent: ${esc(day.burn_location)}`);
    if (day.feedback_comment) noteParts.push(`«${esc(day.feedback_comment)}»`);
    const note = noteParts.length ? `<div class="hist-note">${noteParts.join(" — ")}</div>` : "";
    const header = document.createElement("div");
    header.className = "day-header";
    header.innerHTML = `
      <div style="flex:1">
        <b>${fmtDay(day.date)}</b>
        <div class="hist-sub">${day.total_dose.toFixed(2)} SED totalt · ${day.sessions.length} økt(er)</div>
        ${note}
      </div>
      <div class="hist-actions">${dot || fbBtn}</div>`;
    box.appendChild(header);

    // Enkeltøktene under dagen (fortsatt redigerbare).
    day.sessions.forEach((s) => {
      state.sessionsById[s.id] = s;
      const meta = [CLOUD_LABEL[s.cloud], SIDE_LABEL[s.body_side]].filter(Boolean).join(" · ");
      const el = document.createElement("div");
      el.className = "hist-item session-item";
      el.innerHTML = `
        <div class="hist-main" style="flex:1">
          <b>${s.calculated_dose.toFixed(2)} SED</b>
          <div class="hist-sub">${fmtTime(s.start_time)}–${fmtTime(s.end_time)} · UV ${s.uv_index.toFixed(1)}${s.spf > 1 ? " · SPF " + s.spf : ""}</div>
          <div class="hist-meta">${meta}</div>
        </div>
        <div class="hist-actions">
          <button class="hist-edit" data-sid="${s.id}" title="Rediger">✎</button>
        </div>`;
      box.appendChild(el);
    });
  });
  box.querySelectorAll(".hist-fb-btn").forEach((b) => {
    b.onclick = () => openFeedback(b.dataset.date, Number(b.dataset.dose));
  });
  box.querySelectorAll(".hist-edit").forEach((b) => {
    b.onclick = () => openEdit(state.sessionsById[Number(b.dataset.sid)]);
  });
}

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------
function setRunningUI(running) {
  const btn = $("#toggle-timer");
  if (running) {
    $("#timer-display").classList.remove("hidden");
    $("#dose-title").textContent = "Dose nå (live)";
    btn.textContent = "⏹ Stopp soling";
    btn.classList.add("running");
    $("#manual-add").classList.add("hidden");
  } else {
    $("#timer-display").classList.add("hidden");
    $("#dose-title").textContent = "Dagens dose";
    btn.textContent = "▶ Start soling";
    btn.classList.remove("running");
    $("#manual-add").classList.remove("hidden");
  }
}

function tick() {
  const sec = (Date.now() - state.startTime) / 1000;
  $("#timer-display").textContent = fmtDuration(sec);
  const spf = Number($("#spf").value);
  const sessionDose = computeDose(sec / 60, state.uv || 0, spf, $("#thickness").value, $("#cloud").value);
  // Legg sanntidsdose oppå det som allerede er registrert i dag.
  updateDosePanel(state._baseDose + sessionDose, state.profile.med_cal);
}

async function startTimer() {
  await loadUv();
  const t = await api("/api/today?date=" + localDateStr(new Date()));
  state._baseDose = t.dose_today;
  state.running = true;
  state.startTime = Date.now();
  saveActive({
    startTime: state.startTime,
    baseDose: state._baseDose,
    uv: state.uv || 0,
    spf: $("#spf").value,
    thickness: $("#thickness").value,
    cloud: $("#cloud").value,
    bodySide: $("#body_side").value,
  });
  acquireWakeLock();
  setRunningUI(true);
  tick();
  state.tickHandle = setInterval(tick, 1000);
}

async function stopTimer() {
  clearInterval(state.tickHandle);
  state.tickHandle = null;
  releaseWakeLock();
  state.running = false;
  const endTime = new Date();
  const startTime = new Date(state.startTime);

  const session = await api("/api/session", {
    method: "POST",
    body: JSON.stringify({
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString(),
      local_date: localDateStr(startTime),
      uv_index: state.uv || 0,
      spf: Number($("#spf").value),
      thickness: $("#thickness").value,
      cloud: $("#cloud").value,
      body_side: $("#body_side").value,
    }),
  });

  clearActive();
  setRunningUI(false);
  toast(`Økt lagret: ${session.calculated_dose.toFixed(2)} SED. Vi spør om huden din i morgen.`);
  await refreshHome();
}

// Gjenoppretter en pågående økt etter at fanen ble kastet / appen restartet.
function restoreActiveSession() {
  const active = loadActive();
  if (!active) return false;
  state.running = true;
  state.startTime = active.startTime;
  state._baseDose = active.baseDose || 0;
  state.uv = active.uv || 0;
  $("#spf").value = active.spf;
  $("#thickness").value = active.thickness;
  $("#cloud").value = active.cloud;
  $("#body_side").value = active.bodySide;
  $("#uv-value").textContent = (active.uv ?? 0).toFixed(1);
  setRunningUI(true);
  acquireWakeLock();
  tick();
  state.tickHandle = setInterval(tick, 1000);
  toast("Gjenopprettet pågående soling.");
  return true;
}

// ---------------------------------------------------------------------------
// Manuell økt
// ---------------------------------------------------------------------------
let editingId = null;

function fillManualForm({ start, end, uv, spf, thickness, cloud, bodySide }) {
  $("#m-start").value = toLocalInput(start);
  $("#m-end").value = toLocalInput(end);
  $("#m-uv").value = uv != null ? uv : "";
  $("#m-spf").value = spf;
  $("#m-thickness").value = thickness;
  $("#m-cloud").value = cloud;
  $("#m-body_side").value = bodySide;
}

function openManual() {
  editingId = null;
  const now = new Date();
  fillManualForm({
    start: new Date(now.getTime() - 30 * 60000), // 30 min siden som utgangspunkt
    end: now,
    uv: state.uv != null ? state.uv.toFixed(1) : "",
    spf: "1", thickness: "none", cloud: "clear", bodySide: "both",
  });
  $("#manual-title").textContent = "Legg til økt manuelt";
  $("#manual-delete").classList.add("hidden");
  $("#manual-modal").classList.remove("hidden");
}

function openEdit(s) {
  if (!s) return;
  editingId = s.id;
  fillManualForm({
    start: new Date(s.start_time),
    end: new Date(s.end_time),
    uv: s.uv_index,
    spf: String(s.spf),
    thickness: s.thickness,
    cloud: s.cloud,
    bodySide: s.body_side,
  });
  $("#manual-title").textContent = "Rediger økt";
  $("#manual-delete").classList.remove("hidden");
  $("#manual-modal").classList.remove("hidden");
}

async function saveManual() {
  const s = $("#m-start").value, e = $("#m-end").value;
  if (!s || !e) return toast("Fyll inn start- og sluttid.");
  if ($("#m-uv").value === "") return toast("Fyll inn UV-indeks.");
  const start = new Date(s), end = new Date(e);
  if (end < start) return toast("Sluttid er før starttid.");
  const body = JSON.stringify({
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    local_date: localDateStr(start),
    uv_index: Number($("#m-uv").value),
    spf: Number($("#m-spf").value),
    thickness: $("#m-thickness").value,
    cloud: $("#m-cloud").value,
    body_side: $("#m-body_side").value,
  });
  if (editingId) {
    await api(`/api/session/${editingId}`, { method: "PUT", body });
  } else {
    await api("/api/session", { method: "POST", body });
  }
  $("#manual-modal").classList.add("hidden");
  toast(editingId ? "Økt oppdatert." : "Økt lagt til.");
  editingId = null;
  await refreshHome();
}

async function deleteSession() {
  if (!editingId) return;
  if (!confirm("Slette denne økten? Dette kan ikke angres.")) return;
  await api(`/api/session/${editingId}`, { method: "DELETE" });
  $("#manual-modal").classList.add("hidden");
  toast("Økt slettet.");
  editingId = null;
  await refreshHome();
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------
let feedbackTarget = null;

function renderBurnChips() {
  const box = $("#burn-chips");
  box.innerHTML = "";
  BURN_PARTS.forEach((p) => {
    const c = document.createElement("div");
    c.className = "chip";
    c.textContent = p;
    c.onclick = () => c.classList.toggle("active");
    box.appendChild(c);
  });
}

function openFeedback(date, dose) {
  feedbackTarget = date;
  state.selectedFeedback = null;
  $("#feedback-context").textContent =
    `${fmtDay(date)} fikk du en estimert total dose på ${dose.toFixed(2)} SED. Svaret ditt hjelper appen å lære din faktiske toleranse.`;
  $("#feedback-comment").value = "";
  renderBurnChips();
  $("#burn-section").classList.add("hidden");
  $("#feedback-send").classList.add("hidden");
  document.querySelectorAll(".fb-btn").forEach((b) => b.classList.remove("selected"));
  $("#feedback-modal").classList.remove("hidden");
}

function selectFeedback(fb) {
  state.selectedFeedback = fb;
  document.querySelectorAll(".fb-btn").forEach((b) => b.classList.toggle("selected", b.dataset.fb === fb));
  // Brannsted er bare relevant hvis huden faktisk reagerte.
  $("#burn-section").classList.toggle("hidden", fb === "green");
  $("#feedback-send").classList.remove("hidden");
}

function closeFeedback() {
  $("#feedback-modal").classList.add("hidden");
  feedbackTarget = null;
  state.selectedFeedback = null;
}

async function sendFeedback() {
  if (!state.selectedFeedback || feedbackTarget == null) return toast("Velg et alternativ.");
  const comment = $("#feedback-comment").value.trim() || null;
  let burn = null;
  if (state.selectedFeedback !== "green") {
    const parts = [...$("#burn-chips").querySelectorAll(".chip.active")].map((c) => c.textContent);
    burn = parts.length ? parts.join(", ") : null;
  }
  const res = await api("/api/feedback", {
    method: "POST",
    body: JSON.stringify({
      date: feedbackTarget,
      feedback: state.selectedFeedback,
      comment,
      burn_location: burn,
    }),
  });
  closeFeedback();
  await loadProfile();
  if (Math.abs(res.delta) > 0.001) {
    const dir = res.delta < 0 ? "ned" : "opp";
    toast(`Tålegrensen justert ${dir} til ${res.new_med_cal.toFixed(2)} SED.`);
  } else {
    toast("Takk! Registrert.");
  }
  await refreshHome();
}

async function checkPendingFeedback() {
  const pending = await api("/api/pending-feedback");
  const banner = $("#feedback-banner");
  if (pending.length) {
    banner.classList.remove("hidden");
    banner.textContent = `☀️ Du har ${pending.length} dag(er) som venter på hud-feedback. Trykk her.`;
    banner.onclick = () => openFeedback(pending[0].date, pending[0].total_dose);
  } else {
    banner.classList.add("hidden");
  }
}

// ---------------------------------------------------------------------------
// Profil / innstillinger
// ---------------------------------------------------------------------------
async function loadProfile() {
  state.profile = await api("/api/profile");
  return state.profile;
}

async function saveProfile(fitzpatrick, lat, lon) {
  state.profile = await api("/api/profile", {
    method: "POST",
    body: JSON.stringify({ fitzpatrick, default_lat: lat, default_lon: lon }),
  });
}

function openSettings() {
  renderFitzList($("#settings-fitz"), state.profile.fitzpatrick, (t) => (state.selectedFitz = t));
  state.selectedFitz = state.profile.fitzpatrick;
  $("#lat").value = state.profile.default_lat ?? "";
  $("#lon").value = state.profile.default_lon ?? "";
  show("settings");
}

// ---------------------------------------------------------------------------
// Init / event-binding
// ---------------------------------------------------------------------------
async function init() {
  await loadProfile();

  // Onboarding
  renderFitzList($("#fitz-list"), null, (t) => {
    state.selectedFitz = t;
    $("#onboard-save").disabled = false;
  });
  $("#onboard-save").onclick = async () => {
    const pos = await getPosition();
    await saveProfile(state.selectedFitz, pos?.lat ?? null, pos?.lon ?? null);
    show("home");
    await refreshHome();
  };

  // Timer
  $("#toggle-timer").onclick = () => (state.running ? stopTimer() : startTimer());

  // Manuell økt / redigering
  $("#manual-add").onclick = openManual;
  $("#manual-save").onclick = saveManual;
  $("#manual-delete").onclick = deleteSession;
  $("#manual-cancel").onclick = () => { editingId = null; $("#manual-modal").classList.add("hidden"); };

  // Innstillinger
  $("#settings-btn").onclick = openSettings;
  $("#settings-close").onclick = () => show("home");
  $("#use-gps").onclick = async () => {
    const pos = await getPosition();
    if (pos) {
      $("#lat").value = pos.lat.toFixed(4);
      $("#lon").value = pos.lon.toFixed(4);
      toast("Posisjon hentet.");
    } else {
      toast("Fikk ikke tak i posisjon (krever HTTPS eller localhost).");
    }
  };
  $("#settings-save").onclick = async () => {
    const lat = $("#lat").value ? Number($("#lat").value) : null;
    const lon = $("#lon").value ? Number($("#lon").value) : null;
    await saveProfile(state.selectedFitz, lat, lon);
    show("home");
    await refreshHome();
  };

  // Feedback-modal
  document.querySelectorAll(".fb-btn").forEach((b) => (b.onclick = () => selectFeedback(b.dataset.fb)));
  $("#feedback-send").onclick = sendFeedback;
  $("#feedback-later").onclick = closeFeedback;

  if (state.profile) {
    show("home");
    restoreActiveSession(); // gjenoppta evt. pågående soling før vi tegner resten
    await refreshHome();
  } else {
    show("onboarding");
  }
}

// Når appen kommer i forgrunnen igjen: hold soling i gang, ellers oppdater status.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (state.running) {
    acquireWakeLock();
    if (!state.tickHandle) state.tickHandle = setInterval(tick, 1000);
    tick();
  } else if (state.profile && !$("#home").classList.contains("hidden")) {
    refreshHome();
  }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

init();
