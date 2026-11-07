import { CONFIG, resolveWind, simulate } from "./physics.js";
import { SHAPE_LIMITS, defaultLaunch, defaultPlane, defaultShape, derivePlane } from "./plane.js";
import { FlightView } from "./render.js";
import { initFold } from "./fold.js";

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

const speedInput = document.querySelector("#speed");
const angleInput = document.querySelector("#angle");
const speedOut = document.querySelector("#speed-out");
const angleOut = document.querySelector("#angle-out");
const distanceOut = document.querySelector("#distance");
const timeOut = document.querySelector("#time");
const heightOut = document.querySelector("#max-height");
const statusOut = document.querySelector("#status");
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
  const shape = {};
  for (const field of SHAPE_FIELDS) {
    const input = document.querySelector(`#shape-${field.key}`);
    shape[field.key] = Number(input.value) / field.scale;
  }
  return shape;
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
    output.textContent = (Number(input.value) / field.scale).toFixed(field.digits);
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

function clearStats() {
  distanceOut.textContent = "—";
  timeOut.textContent = "—";
  heightOut.textContent = "—";
  statusOut.textContent = "Set a throw, then launch.";
}

function refresh() {
  syncLabels();
  syncWind();
  const plane = derivePlane(readShape());
  showReadouts(plane);
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
    input.addEventListener("input", refresh);

    label.append(heading, input);
    root.append(label);
  }
}

document.querySelector("#launch").addEventListener("click", () => {
  const plane = derivePlane(readShape());
  const result = simulate(plane, readLaunch(), readWind());
  playing = true;
  distanceOut.textContent = `${result.distance.toFixed(2)} m`;
  timeOut.textContent = `${result.flightTime.toFixed(2)} s`;
  heightOut.textContent = `${result.maxHeight.toFixed(2)} m`;
  statusOut.textContent = endLabel(result.endReason);
  view.play(result, (progress) => {
    if (progress >= 1) playing = false;
  });
});

document.querySelector("#reset").addEventListener("click", () => {
  playing = false;
  speedInput.value = String(launchDefaults.speed);
  angleInput.value = String(launchDefaults.angleDeg);
  applyWindDefaults();
  for (const field of SHAPE_FIELDS) {
    document.querySelector(`#shape-${field.key}`).value = String(shapeDefaults[field.key] * field.scale);
  }
  clearStats();
  refresh();
});

speedInput.addEventListener("input", refresh);
angleInput.addEventListener("input", refresh);
document.querySelectorAll('input[name="wind-mode"]').forEach((input) => {
  input.addEventListener("change", refresh);
});
document.querySelector("#wind-fixed").addEventListener("input", refresh);
document.querySelector("#wind-seed").addEventListener("input", refresh);
document.querySelector("#wind-new-seed").addEventListener("click", () => {
  const seed = Math.floor(Math.random() * 4294967296);
  document.querySelector("#wind-seed").value = String(seed);
  refresh();
});

buildShapeSliders();
applyWindDefaults();
refresh();
view.resize();
initFold(document.querySelector("#fold-panel"), readShape);
