import { designs, getHealth, saveLocalBoard } from "./api.js";
import { diagnose } from "./diagnosis.js";
import { clampShape, initEditor } from "./editor.js";
import { SHAPE_LIMITS, defaultLaunch, defaultPlane, defaultShape, derivePlane } from "./plane.js";
import { CONFIG, resolveWind, simulate } from "./physics.js";
import { FlightView } from "./render.js";

const SHAPE_FIELDS = [
  { key: "span", label: "Wing span", unit: "cm", scale: 100, step: 0.5, digits: 1 },
  { key: "rootChord", label: "Root chord", unit: "cm", scale: 100, step: 0.1, digits: 1 },
  { key: "tipChord", label: "Tip chord", unit: "cm", scale: 100, step: 0.1, digits: 1 },
  { key: "sweepDeg", label: "Sweep", unit: "°", scale: 1, step: 1, digits: 0 },
  { key: "tailArea", label: "Tail area", unit: "cm²", scale: 10000, step: 1, digits: 0 },
  { key: "noseWeight", label: "Nose weight", unit: "g", scale: 1, step: 0.1, digits: 1 },
];

const launchDefaults = defaultLaunch();
const shapeDefaults = defaultShape();
let shape = { ...shapeDefaults };
let editor = null;

const speedInput = document.querySelector("#speed");
const angleInput = document.querySelector("#angle");
const speedOut = document.querySelector("#speed-out");
const angleOut = document.querySelector("#angle-out");
const distanceOut = document.querySelector("#distance");
const timeOut = document.querySelector("#time");
const heightOut = document.querySelector("#max-height");
const statusOut = document.querySelector("#status");
const headlineOut = document.querySelector("#diagnosis-headline");
const detailsOut = document.querySelector("#diagnosis-details");
const bestOut = document.querySelector("#best-flight");
const historyOut = document.querySelector("#history");
const readoutList = document.querySelector("#readouts");
const canvas = document.querySelector("#flight");

const view = new FlightView(canvas);
let playing = false;

const baseline = defaultPlane();
const baselineFlight = simulate(baseline, launchDefaults, { mode: "off" });
console.log(`Baseline distance: ${baselineFlight.distance.toFixed(2)} m`);
console.log(
  `CG ${(baseline.cg * 100).toFixed(1)} cm, AC ${(baseline.neutralPoint * 100).toFixed(1)} cm, static margin ${(baseline.staticMargin * 100).toFixed(0)}%`
);

function readLaunch() {
  return {
    speed: Number(speedInput.value),
    angleDeg: Number(angleInput.value),
    height: launchDefaults.height,
  };
}

function readWind() {
  const selected = document.querySelector('input[name="wind-mode"]:checked');
  return {
    mode: selected ? selected.value : "off",
    seed: Number(document.querySelector("#wind-seed").value),
    fixedSpeed: Number(document.querySelector("#wind-fixed").value),
  };
}

function syncWind() {
  const mode = readWind().mode;
  document.querySelector("#wind-fixed-wrap").hidden = mode !== "fixed";
  document.querySelector("#wind-seed-wrap").hidden = mode !== "random";
  document.querySelector("#wind-fixed-out").textContent = Number(document.querySelector("#wind-fixed").value).toFixed(1);
}

function applyWindDefaults() {
  const radio = document.querySelector(`input[name="wind-mode"][value="${CONFIG.wind.mode}"]`);
  if (radio) radio.checked = true;
  document.querySelector("#wind-seed").value = String(CONFIG.wind.seed);
  document.querySelector("#wind-fixed").value = String(CONFIG.wind.fixedSpeed);
  syncWind();
}

function readShape() {
  return shape;
}

function writeShape() {
  for (const field of SHAPE_FIELDS) {
    const input = document.querySelector(`#shape-${field.key}`);
    input.value = String(shape[field.key] * field.scale);
  }
}

function endLabel(reason) {
  if (reason === "ground") return "Landed.";
  if (reason === "blown back") return "Blown back.";
  if (reason === "timeout") return "Still aloft when the timer stopped.";
  if (reason === "nan") return "The flight numbers fell apart and the sim stopped.";
  if (reason === "out-of-bounds") return "The flight left the sky and the sim stopped.";
  return "Flight finished.";
}

function syncLabels() {
  speedOut.textContent = Number(speedInput.value).toFixed(1);
  angleOut.textContent = Number(angleInput.value).toFixed(0);
  for (const field of SHAPE_FIELDS) {
    const input = document.querySelector(`#shape-${field.key}`);
    const output = document.querySelector(`#shape-${field.key}-out`);
    output.textContent = Number(input.value).toFixed(field.digits);
  }
}

function showReadouts(plane) {
  const marginPct = plane.staticMargin * 100;
  const marginText = `${marginPct >= 0 ? "+" : ""}${marginPct.toFixed(0)}%`;
  const rows = [
    ["Wing area", `${(plane.wingArea * 10000).toFixed(0)} cm²`],
    ["Aspect ratio", plane.aspectRatio.toFixed(2)],
    ["Total mass", `${(plane.mass * 1000).toFixed(1)} g`],
    ["CG", `${(plane.cg * 100).toFixed(2)} cm`],
    ["AC", `${(plane.neutralPoint * 100).toFixed(2)} cm`],
    ["Static margin", marginText, marginPct >= 0 ? "good" : "bad"],
  ];

  const summary = document.querySelector("#stability-summary");
  if (summary) summary.textContent = `Margin ${marginText}, ${marginPct >= 0 ? "stable" : "unstable"}`;

  readoutList.replaceChildren(
    ...rows.map(([label, value, tone]) => {
      const item = document.createElement("div");
      if (label === "Static margin") item.classList.add("wide");
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = value;
      if (tone) detail.classList.add(tone);
      item.append(term, detail);
      return item;
    })
  );
}

const HISTORY_KEY = "clouds.history";
const BEST_KEY = "clouds.best";

function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode and a full disk both leave the in-memory list working.
  }
}

let history = readStore(HISTORY_KEY, []);
let best = readStore(BEST_KEY, null);
if (!Array.isArray(history)) history = [];

function windLabel(wind) {
  const steady = Number(wind?.steady) || 0;
  if (!wind || wind.mode === "off" || Math.abs(steady) < 0.05) return "calm";
  const kind = steady > 0 ? "tail" : "head";
  return `${Math.abs(steady).toFixed(1)} m/s ${kind}`;
}

function shapeLine(saved) {
  return `${(saved.span * 100).toFixed(0)} cm span, ${(saved.rootChord * 100).toFixed(1)}/${(saved.tipChord * 100).toFixed(1)} cm chords, ${saved.sweepDeg.toFixed(0)}° sweep, ${(saved.tailArea * 10000).toFixed(0)} cm² tail, ${saved.noseWeight.toFixed(1)} g nose`;
}

function launchLine(saved) {
  return `${saved.speed.toFixed(1)} m/s at ${saved.angleDeg.toFixed(0)}°`;
}

function showDiagnosis(note) {
  headlineOut.textContent = note ? note.headline : "";
  detailsOut.replaceChildren(
    ...(note ? note.details : []).map((text) => {
      const item = document.createElement("li");
      item.textContent = text;
      return item;
    })
  );
}

function showBest() {
  if (!best) {
    bestOut.textContent = "Best distance: no flights yet.";
    return;
  }
  bestOut.textContent = `Best distance: ${best.distance.toFixed(2)} m. ${shapeLine(best.shape)}. Launch ${launchLine(best.launch)}.`;
}

function showHistory() {
  historyOut.replaceChildren(
    ...history.map((flight, index) => {
      const item = document.createElement("li");
      const text = document.createElement("p");
      text.textContent = `${flight.distance.toFixed(2)} m · ${flight.flightTime.toFixed(2)} s · ${flight.windLabel} · ${flight.headline}`;
      const load = document.createElement("button");
      load.type = "button";
      load.className = "text";
      load.dataset.load = String(index);
      load.textContent = "Load";
      item.append(text, load);
      return item;
    })
  );
}

function remember(result, note, savedShape, savedLaunch) {
  history.unshift({
    distance: result.distance,
    flightTime: result.flightTime,
    windLabel: windLabel(result.wind),
    headline: note.headline,
    shape: savedShape,
    launch: savedLaunch,
  });
  history = history.slice(0, 10);
  writeStore(HISTORY_KEY, history);
  if (!best || result.distance > best.distance) {
    best = { distance: result.distance, shape: savedShape, launch: savedLaunch };
    writeStore(BEST_KEY, best);
  }
  showBest();
  showHistory();
}

function clearStats() {
  distanceOut.textContent = "—";
  timeOut.textContent = "—";
  heightOut.textContent = "—";
  statusOut.textContent = "Set a throw, then launch.";
  showDiagnosis(null);
}

function refresh() {
  writeShape();
  syncLabels();
  syncWind();
  const plane = derivePlane(shape);
  showReadouts(plane);
  editor.redraw();
  if (!playing) view.showIdle(plane, readLaunch(), resolveWind(readWind()));
}

function buildShapeSliders() {
  const root = document.querySelector("#shape-sliders");
  for (const field of SHAPE_FIELDS) {
    const [min, max] = SHAPE_LIMITS[field.key];
    const label = document.createElement("label");
    label.className = "slider";
    label.htmlFor = `shape-${field.key}`;

    const heading = document.createElement("span");
    heading.className = "slider-label";
    const name = document.createElement("span");
    name.textContent = field.label;
    const value = document.createElement("span");
    const strong = document.createElement("strong");
    strong.id = `shape-${field.key}-out`;
    strong.textContent = (shapeDefaults[field.key] * field.scale).toFixed(field.digits);
    value.append(strong, document.createTextNode(` ${field.unit}`));
    heading.append(name, value);

    const input = document.createElement("input");
    input.id = `shape-${field.key}`;
    input.type = "range";
    input.min = String(min * field.scale);
    input.max = String(max * field.scale);
    input.step = String(field.step);
    input.value = String(shapeDefaults[field.key] * field.scale);
    input.addEventListener("input", () => {
      shape = clampShape({ ...shape, [field.key]: Number(input.value) / field.scale });
      refresh();
    });

    label.append(heading, input);
    root.append(label);
  }
}

const submitBox = document.querySelector("#submit-box");
const submitNote = document.querySelector("#submit-note");
const nameInput = document.querySelector("#pilot-name");
let lastFlight = null;

function pilotName(value) {
  return String(value ?? "").replace(/<[^>]*>/g, "").replace(/[<>]/g, "").trim().slice(0, 20);
}

function offerSubmit(result, shape, launch, wind) {
  const blocked = !(result && result.distance > 0 && result.endReason !== "blown back");
  lastFlight = blocked ? null : { result, shape, launch, wind };
  if (submitBox) submitBox.hidden = blocked;
  if (submitNote) submitNote.textContent = "";
  if (!blocked) {
    document.querySelectorAll("[data-tab]").forEach((button) => {
      const on = button.dataset.tab === "results";
      button.setAttribute("aria-selected", String(on));
      button.tabIndex = on ? 0 : -1;
    });
    document.querySelector("#tab-results").hidden = false;
    document.querySelector("#tab-history").hidden = true;
  }
}

submitBox?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!lastFlight) return;
  const name = pilotName(nameInput.value);
  if (!name) {
    submitNote.textContent = "Enter a name.";
    return;
  }
  const saved = await designs({
    name,
    params: {
      ...lastFlight.shape,
      speed: lastFlight.launch.speed,
      angleDeg: lastFlight.launch.angleDeg,
    },
    wind: lastFlight.wind,
  });
  if (saved?.ok) {
    submitNote.textContent = `Rank ${saved.rank}.`;
    return;
  }
  saveLocalBoard({
    name,
    distance: lastFlight.result.distance,
    span: lastFlight.shape.span,
    chord: lastFlight.shape.rootChord,
    mass: derivePlane(lastFlight.shape).mass,
    speed: lastFlight.launch.speed,
    angle: lastFlight.launch.angleDeg,
    wind: lastFlight.wind.mode === "off" ? "off" : "on",
    createdAt: new Date().toISOString(),
  });
  submitNote.textContent = "Saved locally";
});

document.querySelector("#launch").addEventListener("click", () => {
  const savedShape = { ...readShape() };
  const savedLaunch = readLaunch();
  const plane = derivePlane(savedShape);
  const result = simulate(plane, savedLaunch, readWind());
  const note = diagnose(result, plane, savedLaunch);
  playing = true;
  distanceOut.textContent = `${result.distance.toFixed(2)} m`;
  timeOut.textContent = `${result.flightTime.toFixed(2)} s`;
  heightOut.textContent = `${result.maxHeight.toFixed(2)} m`;
  statusOut.textContent = endLabel(result.endReason);
  showDiagnosis(note);
  remember(result, note, savedShape, savedLaunch);
  offerSubmit(result, savedShape, savedLaunch, readWind());
  view.play(result, (progress) => {
    if (progress >= 1) playing = false;
  });
});

document.querySelector("#reset").addEventListener("click", () => {
  playing = false;
  shape = { ...defaultShape() };
  speedInput.value = String(launchDefaults.speed);
  angleInput.value = String(launchDefaults.angleDeg);
  applyWindDefaults();
  clearStats();
  offerSubmit(null);
  refresh();
});

speedInput.addEventListener("input", refresh);
angleInput.addEventListener("input", refresh);
document.querySelectorAll('input[name="wind-mode"]').forEach((input) => {
  input.addEventListener("change", refresh);
});
document.querySelector("#wind-fixed").addEventListener("input", refresh);
document.querySelector("#wind-seed").addEventListener("input", refresh);
historyOut.addEventListener("click", (event) => {
  const button = event.target.closest("[data-load]");
  if (!button) return;
  const flight = history[Number(button.dataset.load)];
  if (!flight) return;
  playing = false;
  shape = clampShape(flight.shape);
  speedInput.value = String(flight.launch.speed);
  angleInput.value = String(flight.launch.angleDeg);
  refresh();
});

document.querySelector("#history-clear").addEventListener("click", () => {
  history = [];
  writeStore(HISTORY_KEY, history);
  showHistory();
});

document.querySelector("#wind-new-seed").addEventListener("click", () => {
  const seed = Math.floor(Math.random() * 4294967296);
  document.querySelector("#wind-seed").value = String(seed);
  refresh();
});

document.querySelectorAll(".control-body details").forEach((details) => {
  details.addEventListener("toggle", () => {
    if (!details.open) return;
    const extra = details.querySelector(".readouts");
    if (extra) extra.scrollIntoView({ block: "nearest" });
  });
});

document.querySelectorAll("[data-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    const name = button.dataset.tab;
    document.querySelectorAll("[data-tab]").forEach((other) => {
      const on = other === button;
      other.setAttribute("aria-selected", String(on));
      other.tabIndex = on ? 0 : -1;
    });
    document.querySelector("#tab-results").hidden = name !== "results";
    document.querySelector("#tab-history").hidden = name !== "history";
  });
});

buildShapeSliders();
applyWindDefaults();
editor = initEditor(document.querySelector("#editor"), readShape, (next) => {
  shape = clampShape(next);
  refresh();
});
refresh();
showBest();
showHistory();
view.resize();

const services = { coach: false, db: false };
getHealth().then((health) => {
  if (!health) return;
  services.coach = health.coach === true;
  services.db = health.db === true;
});
