import { diagnose } from "../public/diagnosis.js";
import { simulate } from "../public/physics.js";
import { defaultLaunch, defaultShape, derivePlane } from "../public/plane.js";

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }
}

const shape = defaultShape();
const plane = derivePlane(shape);
const launch = defaultLaunch();

function check(name, result, usedPlane, usedLaunch, tag) {
  const note = diagnose(result, usedPlane, usedLaunch);
  console.log(`${name}: ${note.tags[0]} — ${note.headline}`);
  assert(note.tags[0] === tag, `${name} headline tag should be ${tag}, got ${note.tags[0]}`);
  assert(note.details.length <= 3, `${name} should keep at most 3 details`);
  assert(typeof note.headline === "string" && note.headline.length > 0, `${name} needs a headline`);
}

const blown = simulate(plane, launch, { mode: "fixed", fixedSpeed: -3, seed: 1 });
check("blown-back", blown, plane, launch, "blown-back");
assert(
  diagnose(blown, plane, launch).headline.includes("3.0 m/s headwind"),
  "blown-back headline should name the 3.0 m/s headwind"
);

const noseShape = { ...shape, noseWeight: 8, tailArea: 0.001 };
const nosePlane = derivePlane(noseShape);
const nose = simulate(nosePlane, launch, { mode: "off" });
check("nose-heavy", nose, nosePlane, launch, "nose-heavy");

const stallLaunch = { speed: 2.2, angleDeg: 25, height: 1.5 };
const stall = simulate(plane, stallLaunch, { mode: "off" });
check("stall", stall, plane, stallLaunch, "stall");

const tail = simulate(plane, launch, { mode: "fixed", fixedSpeed: 2, seed: 1 });
check("tailwind", tail, plane, launch, "tailwind");
assert(diagnose(tail, plane, launch).headline.includes("added"), "tailwind should say how many meters it added");

const glide = simulate(plane, launch, { mode: "off" });
check("good-glide", glide, plane, launch, "good-glide");
assert(glide.distance.toFixed(2) === "12.39", "diagnosis must leave the 12.39 m glide alone");

if (process.exitCode) {
  console.error("Diagnosis checks failed.");
} else {
  console.log("Diagnosis checks passed.");
}
