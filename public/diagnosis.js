// Plain-language notes on a finished flight. No DOM.

import { CONFIG, simulate } from "./physics.js";

/** Cutoffs for the rules below. Static margin is a fraction of the mean chord. */
export const LIMITS = {
  noseHeavyMargin: 0.45, // well above the default glider's +0.20
  earlyDiveSeconds: 1.5, // a nose-heavy dive is over quickly
  earlyDiveClimb: 0.15, // meters above the release height; less than this never really climbed
  referenceSpeed: 4, // m/s, a throw that suits the reference loading
  referenceLoading: 1.65, // N/m^2, the default glider
  slowFactor: 0.7, // slower than this share of the ideal throw
  fastFactor: 1.8, // faster than this share of the ideal throw
  steepAngle: 20, // degrees
  flatAngle: 0, // degrees
  windSpeed: 0.4, // m/s of steady wind worth mentioning
  windMeters: 0.4, // meters gained or lost versus the same throw with wind off
  recoverGap: 0.15, // seconds after stallTime before a lower angle counts as a recovery
};

const G = 9.81;
const STALL = (CONFIG.stallAngleDeg * Math.PI) / 180;

function loading(plane) {
  return (plane.mass * G) / Math.max(plane.wingArea, 1e-6);
}

function idealSpeed(plane) {
  return LIMITS.referenceSpeed * Math.sqrt(loading(plane) / LIMITS.referenceLoading);
}

function signedPct(margin) {
  const pct = margin * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`;
}

function stallRecovered(result) {
  return result.samples.some(
    (sample) => sample.t > result.stallTime + LIMITS.recoverGap && Math.abs(sample.alpha) < STALL
  );
}

/**
 * First matching rule is the headline. Later matches become details, at most three.
 * @returns {{ headline: string, details: string[], tags: string[] }}
 */
export function diagnose(result, plane, launch) {
  const notes = [];
  const speed = Number(launch.speed);
  const angle = Number(launch.angleDeg);
  const height = Number(launch.height) || 0;
  const margin = Number(plane.staticMargin);
  const steady = Number(result.wind?.steady) || 0;
  const climb = result.maxHeight - height;

  if (result.blownBack || result.endReason === "blown back") {
    const head = Math.abs(steady);
    notes.push({
      tag: "blown-back",
      headline:
        head >= LIMITS.windSpeed
          ? `A ${head.toFixed(1)} m/s headwind stalled it and carried it back behind you.`
          : "It came back behind you.",
    });
  }

  if (
    margin >= LIMITS.noseHeavyMargin &&
    result.flightTime <= LIMITS.earlyDiveSeconds &&
    climb <= LIMITS.earlyDiveClimb
  ) {
    notes.push({
      tag: "nose-heavy",
      headline: "The CG is far ahead of the AC, so it dove.",
      detail: `Static margin is ${signedPct(margin)}, and it was down in ${result.flightTime.toFixed(1)} s.`,
    });
  }

  if (margin <= 0) {
    notes.push({
      tag: "tail-heavy",
      headline: result.stalled
        ? "The balance is tail-heavy, so it pitched up and stalled."
        : "The balance is tail-heavy, so it wants to pitch up.",
      detail: `Static margin is ${signedPct(margin)}.`,
    });
  }

  if (result.stalled && Number.isFinite(result.stallTime)) {
    const recovered = stallRecovered(result);
    notes.push({
      tag: "stall",
      headline: recovered
        ? `It stalled at ${result.stallTime.toFixed(1)} s, then recovered.`
        : `It stalled at ${result.stallTime.toFixed(1)} s and did not recover.`,
    });
  }

  const ideal = idealSpeed(plane);
  if (Number.isFinite(speed) && speed < ideal * LIMITS.slowFactor) {
    notes.push({
      tag: "slow",
      headline: `${speed.toFixed(1)} m/s is too slow for this wing loading.`,
      detail: `A throw near ${ideal.toFixed(1)} m/s suits a loading of ${loading(plane).toFixed(1)} N/m².`,
    });
  } else if (Number.isFinite(speed) && speed > ideal * LIMITS.fastFactor) {
    notes.push({
      tag: "fast",
      headline: `${speed.toFixed(1)} m/s is too fast for this wing loading.`,
      detail: `A throw near ${ideal.toFixed(1)} m/s suits a loading of ${loading(plane).toFixed(1)} N/m².`,
    });
  }

  if (angle > LIMITS.steepAngle) {
    notes.push({ tag: "steep", headline: `${angle.toFixed(0)}° is too steep a throw.` });
  } else if (angle < LIMITS.flatAngle) {
    notes.push({ tag: "flat", headline: `${angle.toFixed(0)}° is too flat a throw.` });
  }

  if (result.wind?.mode !== "off" && Math.abs(steady) >= LIMITS.windSpeed) {
    const calm = simulate(plane, launch, { mode: "off" });
    const delta = result.distance - calm.distance;
    if (Math.abs(delta) >= LIMITS.windMeters) {
      const kind = steady > 0 ? "tailwind" : "headwind";
      const verb = delta >= 0 ? "added" : "cost";
      notes.push({
        tag: kind,
        headline: `A ${Math.abs(steady).toFixed(1)} m/s ${kind} ${verb} about ${Math.abs(delta).toFixed(1)} m.`,
      });
    }
  }

  if (notes.length === 0 && result.endReason === "ground" && result.distance > 0 && !result.stalled) {
    const drop = Math.max(height, 0.05);
    const ratio = result.distance / drop;
    notes.push({
      tag: "good-glide",
      headline: `A smooth glide, about ${ratio.toFixed(1)} m forward for each meter of drop.`,
    });
  }

  if (notes.length === 0) {
    notes.push({ tag: "finished", headline: "The flight finished." });
  }

  const details = [];
  if (notes[0].detail) details.push(notes[0].detail);
  for (let i = 1; i < notes.length && details.length < 3; i += 1) {
    details.push(notes[i].detail || notes[i].headline);
  }

  return {
    headline: notes[0].headline,
    details,
    tags: notes.map((note) => note.tag),
  };
}
