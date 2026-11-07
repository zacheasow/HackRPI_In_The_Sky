import { clampShape } from "../public/editor.js";
import { CONFIG, simulate } from "../public/physics.js";
import { LAUNCH_HEIGHT, derivePlane } from "../public/plane.js";

function clamp(value, [min, max], fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function cleanName(value) {
  const stripped = String(value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "")
    .trim();
  if (!stripped) return null;
  return stripped.slice(0, 20);
}

export function normalizeWind(wind) {
  const source = wind && typeof wind === "object" ? wind : {};
  const mode = source.mode === "random" || source.mode === "fixed" || source.mode === "off" ? source.mode : "off";
  const seed = Number.isFinite(Number(source.seed)) ? Number(source.seed) : CONFIG.wind.seed;
  const fixedSpeed = clamp(source.fixedSpeed, [CONFIG.wind.steadyMin, CONFIG.wind.steadyMax], CONFIG.wind.fixedSpeed);
  return { mode, seed, fixedSpeed };
}

export function prepareEntry(body) {
  const name = cleanName(body?.name);
  if (!name) return { error: "Name must be 1 to 20 characters" };
  const source = body?.params && typeof body.params === "object" ? body.params : {};
  const shape = clampShape(source);
  const launch = {
    speed: clamp(source.speed, CONFIG.limits.speed, 4),
    angleDeg: clamp(source.angleDeg, CONFIG.limits.angleDeg, 3),
    height: LAUNCH_HEIGHT,
  };
  const wind = normalizeWind(body?.wind);
  const plane = derivePlane(shape);
  const result = simulate(plane, launch, wind);
  return {
    name,
    params: { ...shape, speed: launch.speed, angleDeg: launch.angleDeg },
    wind,
    distance: result.distance,
    endReason: result.endReason,
    mass: plane.mass,
  };
}

export function readLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 20;
  return Math.min(50, Math.max(1, Math.floor(n)));
}

export function publicEntry(doc) {
  const params = doc.params || {};
  return {
    name: doc.name,
    distance: doc.distance,
    span: params.span,
    chord: params.rootChord,
    mass: doc.mass,
    speed: params.speed,
    angle: params.angleDeg,
    wind: doc.wind?.mode === "off" ? "off" : "on",
    createdAt: doc.createdAt,
  };
}
