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

const state = {
  profile: null,
  uv: null,
  running: false,
  startTime: null,
  tickHandle: null,
  selectedFitz: null,
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

// Samme doseformel som backend, for sanntidsvisning mens timeren går.
function effectiveSpf(spf, thickness) {
  if (thickness === "none" || spf <= 1) return 1;
  if (thickness === "thin") return Math.max(1, spf / 2);
  return spf;
}
function computeDose(minutes, uv, spf, thickness) {
  return (uv * (minutes / 60) * 0.9) / effectiveSpf(spf, thickness);
}

function doseColor(pct) {
  if (pct < 60) return "linear-gradient(90deg,#34c759,#a8e05f)";
  if (pct < 100) return "linear-gradient(90deg,#ffcc00,#ff9500)";
  return "linear-gradient(90deg,#ff5252,#d32f2f)";
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
  if (!state.running) await loadUv();
  await refreshDose();
  await refreshHistory();
  await checkPendingFeedback();
}

async function refreshDose() {
  const t = await api("/api/today");
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
  const sessions = await api("/api/sessions");
  const box = $("#history");
  box.innerHTML = "";
  if (!sessions.length) {
    box.innerHTML = `<p class="hint">Ingen økter ennå. Trykk «Start soling» for å begynne.</p>`;
    return;
  }
  sessions.slice(0, 20).forEach((s) => {
    const dot = s.feedback ? `<div class="hist-dot dot-${s.feedback}"></div>` : "";
    const fbBtn = s.feedback ? "" :
      `<button class="hist-fb-btn" data-sid="${s.id}" data-dose="${s.calculated_dose}">Gi feedback</button>`;
    const el = document.createElement("div");
    el.className = "hist-item";
    el.innerHTML = `
      <div class="hist-main">
        <b>${s.calculated_dose.toFixed(2)} SED</b>
        <div class="hist-sub">${fmtDate(s.start_time)} · UV ${s.uv_index.toFixed(1)}${s.spf > 1 ? " · SPF " + s.spf : ""}</div>
      </div>
      ${dot || fbBtn}`;
    box.appendChild(el);
  });
  box.querySelectorAll(".hist-fb-btn").forEach((b) => {
    b.onclick = () => openFeedback(Number(b.dataset.sid), Number(b.dataset.dose));
  });
}

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------
function tick() {
  const sec = (Date.now() - state.startTime) / 1000;
  $("#timer-display").textContent = fmtDuration(sec);
  const spf = Number($("#spf").value);
  const thickness = $("#thickness").value;
  const sessionDose = computeDose(sec / 60, state.uv || 0, spf, thickness);
  // Legg sanntidsdose oppå det som allerede er registrert i dag.
  updateDosePanel(state._baseDose + sessionDose, state.profile.med_cal);
}

async function startTimer() {
  await loadUv();
  const t = await api("/api/today");
  state._baseDose = t.dose_today;
  state.running = true;
  state.startTime = Date.now();
  $("#timer-display").classList.remove("hidden");
  $("#dose-title").textContent = "Dose nå (live)";
  const btn = $("#toggle-timer");
  btn.textContent = "⏹ Stopp soling";
  btn.classList.add("running");
  tick();
  state.tickHandle = setInterval(tick, 1000);
}

async function stopTimer() {
  clearInterval(state.tickHandle);
  state.running = false;
  const endTime = new Date();
  const startTime = new Date(state.startTime);
  const spf = Number($("#spf").value);
  const thickness = $("#thickness").value;

  const session = await api("/api/session", {
    method: "POST",
    body: JSON.stringify({
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString(),
      uv_index: state.uv || 0,
      spf,
      thickness,
    }),
  });

  $("#timer-display").classList.add("hidden");
  $("#dose-title").textContent = "Dagens dose";
  const btn = $("#toggle-timer");
  btn.textContent = "▶ Start soling";
  btn.classList.remove("running");

  toast(`Økt lagret: ${session.calculated_dose.toFixed(2)} SED. Vi spør om huden din i morgen.`);
  await refreshHome();
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------
let feedbackTarget = null;

function openFeedback(sessionId, dose) {
  feedbackTarget = sessionId;
  $("#feedback-context").textContent =
    `Denne økten ga en estimert dose på ${dose.toFixed(2)} SED. Svaret ditt hjelper appen å lære din faktiske toleranse.`;
  $("#feedback-modal").classList.remove("hidden");
}

function closeFeedback() {
  $("#feedback-modal").classList.add("hidden");
  feedbackTarget = null;
}

async function sendFeedback(fb) {
  if (feedbackTarget == null) return;
  const res = await api("/api/feedback", {
    method: "POST",
    body: JSON.stringify({ session_id: feedbackTarget, feedback: fb }),
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
    banner.textContent = `☀️ Du har ${pending.length} økt(er) som venter på hud-feedback. Trykk her.`;
    banner.onclick = () => openFeedback(pending[0].id, pending[0].calculated_dose);
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
    // Prøv å hente posisjon som standard hjemmeposisjon.
    const pos = await getPosition();
    await saveProfile(state.selectedFitz, pos?.lat ?? null, pos?.lon ?? null);
    show("home");
    await refreshHome();
  };

  // Timer
  $("#toggle-timer").onclick = () => (state.running ? stopTimer() : startTimer());

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
  document.querySelectorAll(".fb-btn").forEach((b) => (b.onclick = () => sendFeedback(b.dataset.fb)));
  $("#feedback-later").onclick = closeFeedback;

  if (state.profile) {
    show("home");
    await refreshHome();
  } else {
    show("onboarding");
  }
}

// Oppdater UV/status når appen kommer i forgrunnen igjen.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.profile && !$("#home").classList.contains("hidden")) {
    refreshHome();
  }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

init();
