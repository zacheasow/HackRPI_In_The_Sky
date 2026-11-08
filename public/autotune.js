// Seeded random-restart hill climb over the editor shape.
// shortcut: simulate is called with no recorder or telemetry argument, so these flights stay unlogged until that API exists.

import { clampShape } from "./editor.js";
import { SHAPE_LIMITS, defaultShape, derivePlane } from "./plane.js";
import { simulate } from "./physics.js";

export const TUNE_EVALS = 300;

const KEYS = ["span", "rootChord", "tipChord", "sweepDeg", "tailArea", "noseWeight"];
const STEP = {
  span: 0.03,
  rootChord: 0.01,
  tipChord: 0.01,
  sweepDeg: 4,
  tailArea: 0.001,
  noseWeight: 0.6,
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function positiveMargin(shape) {
  return derivePlane(shape).staticMargin > 0;
}

function shuffle(keys, rng) {
  const next = keys.slice();
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const swap = next[i];
    next[i] = next[j];
    next[j] = swap;
  }
  return next;
}

export function createSearch(shape, launch, wind, seed = 1) {
  const start = clampShape(shape);
  const rng = mulberry32(seed);
  let evals = 0;
  let before = null;
  let bestShape = { ...start };
  let bestDistance = null;
  let current = { ...start };
  let currentDistance = null;
  let scale = 1;
  let proposals = [];
  let index = 0;
  let sweepBest = null;
  let sweepBestDistance = null;
  let improved = false;
  let phase = "start";

  function measure(candidate) {
    if (evals >= TUNE_EVALS) return null;
    const plane = derivePlane(candidate);
    if (!(plane.staticMargin > 0)) return null;
    evals += 1;
    return simulate(plane, launch, wind).distance;
  }

  function keep(candidate, distance) {
    if (bestDistance == null || distance > bestDistance) {
      bestShape = { ...candidate };
      bestDistance = distance;
    }
  }

  function propose(base, key, direction) {
    const [min, max] = SHAPE_LIMITS[key];
    const next = { ...base };
    next[key] = Math.min(max, Math.max(min, base[key] + direction * STEP[key] * scale));
    return clampShape(next);
  }

  function beginSweep() {
    proposals = [];
    for (const key of shuffle(KEYS, rng)) {
      proposals.push(propose(current, key, 1));
      proposals.push(propose(current, key, -1));
    }
    index = 0;
    sweepBest = null;
    sweepBestDistance = null;
    improved = false;
    phase = "sweep";
  }

  function randomStart() {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const next = {};
      for (const key of KEYS) {
        const [min, max] = SHAPE_LIMITS[key];
        next[key] = min + rng() * (max - min);
      }
      const clamped = clampShape(next);
      if (positiveMargin(clamped)) return clamped;
    }
    const fallback = clampShape(defaultShape());
    return positiveMargin(fallback) ? fallback : { ...start };
  }

  function tick() {
    if (evals >= TUNE_EVALS) return;
    if (phase === "start") {
      const distance = measure(start);
      before = distance;
      if (distance != null) {
        bestDistance = distance;
        currentDistance = distance;
        bestShape = { ...start };
      }
      beginSweep();
      return;
    }
    if (phase === "restart") {
      current = randomStart();
      const distance = measure(current);
      scale = 1;
      if (distance != null) {
        currentDistance = distance;
        keep(current, distance);
      }
      beginSweep();
      return;
    }
    if (index >= proposals.length) {
      if (improved && sweepBest) {
        current = sweepBest;
        currentDistance = sweepBestDistance;
      } else {
        scale *= 0.5;
        if (scale < 0.08) {
          phase = "restart";
          return;
        }
      }
      beginSweep();
      return;
    }
    const candidate = proposals[index];
    index += 1;
    const distance = measure(candidate);
    if (distance == null) return;
    const beatsCurrent = currentDistance == null || distance > currentDistance;
    if (beatsCurrent && (sweepBestDistance == null || distance > sweepBestDistance)) {
      sweepBest = { ...candidate };
      sweepBestDistance = distance;
      improved = true;
    }
    keep(candidate, distance);
  }

  return {
    get evals() {
      return evals;
    },
    get bestDistance() {
      return bestDistance;
    },
    get done() {
      return evals >= TUNE_EVALS;
    },
    step(count = 3) {
      const target = Math.min(TUNE_EVALS, evals + count);
      let spins = 0;
      while (evals < target && spins < 400) {
        const seen = evals;
        tick();
        if (evals === seen) spins += 1;
      }
    },
    result() {
      return {
        shape: clampShape(bestShape),
        before,
        after: bestDistance,
        evals,
      };
    },
  };
}

export function tune(shape, launch, wind, seed = 1) {
  const search = createSearch(shape, launch, wind, seed);
  let guard = 0;
  while (!search.done && guard < TUNE_EVALS * 5) {
    search.step(32);
    guard += 1;
  }
  return search.result();
}
