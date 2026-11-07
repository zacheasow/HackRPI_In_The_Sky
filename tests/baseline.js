import { CONFIG, simulate } from "../public/physics.js";
import { defaultLaunch, defaultPlane } from "../public/plane.js";

function energy(sample, mass, inertia) {
  const speed2 = sample.vx * sample.vx + sample.vy * sample.vy;
  return 0.5 * mass * speed2 + 0.5 * inertia * sample.q * sample.q + mass * CONFIG.g * Math.max(sample.y, 0);
}

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }
}

const plane = defaultPlane();
const launch = defaultLaunch();
const result = simulate(plane, launch);

console.log(`Baseline distance: ${result.distance.toFixed(2)} m`);
console.log(
  `CG ${(plane.cg * 100).toFixed(1)} cm, AC ${(plane.neutralPoint * 100).toFixed(1)} cm, static margin ${(plane.staticMargin * 100).toFixed(0)}%`
);
console.log(`Flight time: ${result.flightTime.toFixed(2)} s`);
console.log(`Max height: ${result.maxHeight.toFixed(2)} m`);
console.log(`End: ${result.endReason}`);
console.log(result.stalled ? `Stalled: yes, at t=${result.stallTime.toFixed(2)} s` : "Stalled: no");

assert(result.endReason === "ground", "baseline flight should reach the ground");
assert(Number.isFinite(result.distance) && result.distance > 12, "baseline should glide farther than 12 m");
assert(result.distance < 80, "baseline should stay in a paper-airplane range");
assert(result.stalled === false, "baseline throw should stay below the stall angle");
assert(result.flightTime > 1, "baseline flight should last more than a second");
assert(result.maxHeight >= launch.height - 0.01, "max height should include the launch height");
assert(result.samples.length > 5, "trajectory should be recorded");
assert(result.samples[result.samples.length - 1].y <= 0.001, "last sample should be on the ground");

const startEnergy = energy(result.samples[0], result.plane.mass, result.plane.inertia);
let peakEnergy = startEnergy;
for (const sample of result.samples) {
  peakEnergy = Math.max(peakEnergy, energy(sample, result.plane.mass, result.plane.inertia));
}
assert(peakEnergy < startEnergy * 1.08 + 0.02, "mechanical energy should not grow (lift/drag direction)");

const fast = simulate(plane, { speed: 100, angleDeg: 10, height: 1.5 });
const capped = simulate(plane, { speed: 15, angleDeg: 10, height: 1.5 });
assert(Math.abs(fast.distance - capped.distance) < 1e-6, "launch speed should clamp to 15 m/s");

const missing = simulate({ wingArea: NaN, mass: NaN }, { speed: NaN, angleDeg: NaN, height: NaN });
assert(Number.isFinite(missing.distance), "NaN inputs should fall back to a finite flight");
assert(missing.endReason !== "nan", "fallback flight should stay numerically valid");

if (process.exitCode) {
  console.error("Baseline checks failed.");
} else {
  console.log("Baseline checks passed.");
}
