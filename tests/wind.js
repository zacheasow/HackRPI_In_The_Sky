import { simulate } from "../public/physics.js";
import { defaultLaunch, defaultPlane } from "../public/plane.js";

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }
}

// The tuned throw from the calm model, locked at 16.45 m with wind off.
const tunedThrow = {
  wingArea: 0.015,
  aspectRatio: 5.5,
  mass: 0.01,
  cg: 0.062,
  ac: 0.08,
  meanChord: 0.07,
  bodyLength: 0.28,
  tailArea: 0.004,
  tailArm: 0.16,
  tailIncidence: -0.145,
  inertia: (0.01 * 0.28 * 0.28) / 12,
};

const fastLaunch = { speed: 7, angleDeg: 4, height: 1.5 };
const glider = defaultPlane();
const glideLaunch = defaultLaunch();

const fast = simulate(tunedThrow, fastLaunch, { mode: "off" });
const glide = simulate(glider, glideLaunch, { mode: "off" });
const glideOmitted = simulate(glider, glideLaunch);

console.log(`Wind off, 7 m/s at 4°: ${fast.distance.toFixed(2)} m`);
console.log(`Wind off, default glider: ${glide.distance.toFixed(2)} m`);

assert(fast.distance.toFixed(2) === "16.45", "calm 7 m/s at 4° should stay 16.45 m");
assert(Math.abs(fast.distance - 16.45268614322461) < 1e-9, "calm fast throw should match the no-wind distance exactly");
assert(glide.distance.toFixed(2) === "12.39", "calm default glider should stay 12.39 m");
assert(Math.abs(glide.distance - 12.391743930607273) < 1e-9, "calm glider should match the no-wind distance exactly");
assert(glideOmitted.distance === glide.distance, "omitting wind should stay in mode off");
assert(glide.wind.mode === "off" && glide.wind.steady === 0 && glide.wind.gustMax === 0 && glide.wind.avg === 0, "off wind is calm");

const seed = { mode: "random", seed: 42 };
const once = simulate(glider, glideLaunch, seed);
const twice = simulate(glider, glideLaunch, seed);
assert(once.distance === twice.distance, "the same seed should repeat the distance");
assert(once.wind.seed === 42 && twice.wind.steady === once.wind.steady, "the same seed should repeat the steady wind");

const calm = simulate(glider, glideLaunch, { mode: "off" }).distance;
const tail = simulate(glider, glideLaunch, { mode: "fixed", fixedSpeed: 3, seed: 1 });
const head = simulate(glider, glideLaunch, { mode: "fixed", fixedSpeed: -3, seed: 1 });
console.log(`Fixed +3 m/s: ${tail.distance.toFixed(2)} m, fixed -3 m/s: ${head.distance.toFixed(2)} m (${head.endReason}, ${head.flightTime.toFixed(2)} s)`);
assert(tail.wind.mode === "fixed" && tail.wind.steady === 3, "fixed mode should keep the requested tailwind");
assert(head.wind.steady === -3, "fixed mode should keep the requested headwind");
assert(tail.distance > calm, "a +3 m/s tailwind should land farther than calm");
assert(head.distance >= 0, "a headwind distance should not be negative");
assert(head.distance < calm, "a -3 m/s headwind should land shorter than calm");
assert(head.flightTime < 15, "a -3 m/s headwind should finish within 15 s");
assert(head.blownBack === true && head.endReason === "blown back", "a backward landing should be marked blown back");

if (process.exitCode) {
  console.error("Wind checks failed.");
} else {
  console.log("Wind checks passed.");
}
