import { tune } from "../public/autotune.js";
import { SHAPE_LIMITS, defaultLaunch, defaultShape, derivePlane } from "../public/plane.js";

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }
}

const shape = defaultShape();
const launch = defaultLaunch();
const wind = { mode: "off" };
const first = tune(shape, launch, wind, 1);
const second = tune(defaultShape(), launch, wind, 1);

assert(shape.span === defaultShape().span, "tune does not mutate the input");
assert(first.evals === 300, "search runs 300 flights");
assert(first.after >= first.before, "result is never worse than the start");
assert(derivePlane(first.shape).staticMargin > 0, "margin stays positive");

for (const key of Object.keys(SHAPE_LIMITS)) {
  const [min, max] = SHAPE_LIMITS[key];
  assert(first.shape[key] >= min && first.shape[key] <= max, `${key} stays inside the editor range`);
  assert(first.shape[key] === second.shape[key], `${key} matches for the same seed`);
}

assert(first.before === second.before && first.after === second.after, "same seed and wind give the same distance");

if (!process.exitCode) {
  console.log(`Auto-tune default glider, seed 1, wind off: ${first.before.toFixed(2)} m -> ${first.after.toFixed(2)} m`);
  console.log("Auto-tune checks passed.");
}
