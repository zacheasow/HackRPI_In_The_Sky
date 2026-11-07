/**
 * Turns an editable paper-airplane shape into the parameters physics.js flies.
 * Lengths are meters from the nose (aft positive) unless noted.
 * Sweep is the quarter-chord sweep: positive sweep moves the wing AC aft.
 */

import { CONFIG } from "./physics.js";

/** Paper layout. These are folds, not sliders. */
export const PAPER = {
  gsm: 0.08, // kg/m^2, standard 80 gsm paper
  fuselageWidth: 0.028, // m
  noseLength: 0.05, // nose tip to the wing-root leading edge, m
  tailBoom: 0.075, // wing-root trailing edge to the tail quarter-chord, m
  tailSpanFraction: 0.42, // tail span relative to wing span
  minTailSpan: 0.07, // m, keeps a huge tail from becoming a long ribbon
  // Fixed up-elevator. Negative incidence trims the nose up.
  tailIncidence: -0.045, // radians
};

export const SHAPE_LIMITS = {
  span: [0.16, 0.42], // m
  rootChord: [0.05, 0.14], // m
  tipChord: [0.02, 0.12], // m
  sweepDeg: [0, 35], // degrees, quarter-chord sweep
  tailArea: [0.001, 0.01], // m^2
  noseWeight: [0, 8], // grams
};

export const LAUNCH_HEIGHT = 1.5;

function clamp(value, [min, max], fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function defaultShape() {
  return {
    span: 0.36,
    rootChord: 0.07,
    tipChord: 0.04,
    sweepDeg: 5,
    tailArea: 0.006,
    noseWeight: 1,
  };
}

export function defaultLaunch() {
  return {
    speed: 4,
    angleDeg: 3,
    height: LAUNCH_HEIGHT,
  };
}

/**
 * Wing area, aspect ratio, mass, CG, wing AC, neutral point, static margin,
 * tail arm, and pitch inertia for one shape.
 * `ac` is the wing aerodynamic center, where the wing's lift acts.
 * `neutralPoint` is the whole-airplane aerodynamic center used for static margin.
 */
export function derivePlane(shape = {}) {
  const base = defaultShape();
  const span = clamp(shape.span, SHAPE_LIMITS.span, base.span);
  const rootChord = clamp(shape.rootChord, SHAPE_LIMITS.rootChord, base.rootChord);
  const tipChord = clamp(shape.tipChord, SHAPE_LIMITS.tipChord, base.tipChord);
  const sweepDeg = clamp(shape.sweepDeg, SHAPE_LIMITS.sweepDeg, base.sweepDeg);
  const tailArea = clamp(shape.tailArea, SHAPE_LIMITS.tailArea, base.tailArea);
  const noseWeight = clamp(shape.noseWeight, SHAPE_LIMITS.noseWeight, base.noseWeight);

  const wingArea = ((rootChord + tipChord) / 2) * span;
  const aspectRatio = (span * span) / wingArea;
  const taper = tipChord / rootChord;
  const meanChord = ((2 / 3) * rootChord * (1 + taper + taper * taper)) / (1 + taper);
  const yMac = (span / 6) * (1 + 2 * taper) / (1 + taper);
  const sweep = (sweepDeg * Math.PI) / 180;

  const wingAc = PAPER.noseLength + 0.25 * rootChord + yMac * Math.tan(sweep);
  const wingCentroid = wingAc + 0.25 * meanChord;

  const tailSpan = Math.max(PAPER.minTailSpan, PAPER.tailSpanFraction * span);
  const tailChord = tailArea / tailSpan;
  const xTail = PAPER.noseLength + rootChord + PAPER.tailBoom;
  const xTailCentroid = xTail + 0.25 * tailChord;
  const bodyLength = xTail + 0.75 * tailChord;

  const xWingTE = PAPER.noseLength + rootChord;
  const xTailLE = xTail - 0.25 * tailChord;
  const boomLength = Math.max(0, xTailLE - xWingTE);
  const noseArea = PAPER.fuselageWidth * PAPER.noseLength;
  const boomArea = PAPER.fuselageWidth * boomLength;
  const fuselageArea = noseArea + boomArea;
  const xFuselage =
    fuselageArea > 0 ? (noseArea * (PAPER.noseLength / 2) + boomArea * (xWingTE + boomLength / 2)) / fuselageArea : 0;

  const wingMass = wingArea * PAPER.gsm;
  const tailMass = tailArea * PAPER.gsm;
  const fuseMass = fuselageArea * PAPER.gsm;
  const noseMass = noseWeight / 1000;
  const mass = wingMass + tailMass + fuseMass + noseMass;

  const cg =
    (wingMass * wingCentroid + tailMass * xTailCentroid + fuseMass * xFuselage + noseMass * 0) /
    Math.max(mass, 1e-9);

  const wingSlope = CONFIG.clAlpha * (aspectRatio / (aspectRatio + 2));
  const tailSlope = CONFIG.tailClAlpha * (1 - CONFIG.downwash);
  const wingWeight = wingSlope * wingArea;
  const tailWeight = tailSlope * tailArea;
  const neutralPoint = (wingAc * wingWeight + xTail * tailWeight) / (wingWeight + tailWeight);
  const staticMargin = (neutralPoint - cg) / meanChord;

  return {
    span,
    rootChord,
    tipChord,
    sweepDeg,
    noseWeight,
    wingArea,
    aspectRatio,
    mass,
    cg,
    ac: wingAc,
    wingAc,
    neutralPoint,
    staticMargin,
    meanChord,
    bodyLength,
    tailArea,
    tailArm: xTail - cg,
    tailIncidence: PAPER.tailIncidence,
    inertia: (mass * bodyLength * bodyLength) / 12,
  };
}

export function defaultPlane() {
  return derivePlane(defaultShape());
}
