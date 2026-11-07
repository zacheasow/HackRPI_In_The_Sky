import { sanitizeInputs } from "../public/physics.js";
import { PAPER, SHAPE_LIMITS, derivePlane, defaultLaunch, defaultPlane, defaultShape } from "../public/plane.js";

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }
}

function close(actual, expected, epsilon, message) {
  assert(Math.abs(actual - expected) <= epsilon, `${message}: got ${actual}, expected ${expected}`);
}

const shape = defaultShape();
const plane = derivePlane(shape);

const wingArea = ((shape.rootChord + shape.tipChord) / 2) * shape.span;
close(plane.wingArea, wingArea, 1e-12, "wing area");
close(plane.aspectRatio, (shape.span * shape.span) / wingArea, 1e-12, "aspect ratio");
close(plane.inertia, (plane.mass * plane.bodyLength * plane.bodyLength) / 12, 1e-12, "inertia");
close(plane.staticMargin, (plane.neutralPoint - plane.cg) / plane.meanChord, 1e-12, "static margin");

const rectangular = derivePlane({
  ...shape,
  rootChord: 0.08,
  tipChord: 0.08,
  sweepDeg: 0,
});
close(rectangular.meanChord, 0.08, 1e-12, "rectangular mean chord");
close(rectangular.wingAc, PAPER.noseLength + 0.25 * 0.08, 1e-12, "unswept wing AC");

const swept = derivePlane({ ...shape, sweepDeg: 30 });
const straight = derivePlane({ ...shape, sweepDeg: 0 });
assert(swept.wingAc > straight.wingAc, "sweep should move the wing AC aft");
assert(swept.neutralPoint > straight.neutralPoint, "sweep should move the neutral point aft");

const light = derivePlane({ ...shape, noseWeight: 1 });
const heavy = derivePlane({ ...shape, noseWeight: 6 });
close(heavy.mass - light.mass, 0.005, 1e-12, "nose weight adds its own mass");
assert(heavy.cg < light.cg, "nose weight should move the CG forward");
assert(heavy.staticMargin > light.staticMargin, "a forward CG should raise static margin");

const smallTail = derivePlane({ ...shape, tailArea: 0.0015 });
const bigTail = derivePlane({ ...shape, tailArea: 0.008 });
assert(bigTail.neutralPoint > smallTail.neutralPoint, "a larger tail should move the AC aft");

const fallback = derivePlane({
  span: NaN,
  rootChord: NaN,
  tipChord: NaN,
  sweepDeg: NaN,
  tailArea: NaN,
  noseWeight: NaN,
});
close(fallback.wingArea, plane.wingArea, 1e-12, "NaN shape falls back to the default");

assert(plane.staticMargin > 0.05, "the default airplane should be stable");
assert(plane.cg < plane.neutralPoint, "the default CG should sit ahead of the AC");

const keys = ["span", "rootChord", "tipChord", "sweepDeg", "tailArea", "noseWeight"];
const ranges = keys.map((key) => SHAPE_LIMITS[key]);
function walk(index, partial) {
  if (index === keys.length) {
    const derived = derivePlane(partial);
    const flown = sanitizeInputs(derived, defaultLaunch()).plane;
    for (const key of ["wingArea", "aspectRatio", "mass", "cg", "ac", "meanChord", "bodyLength", "tailArea", "tailArm", "inertia"]) {
      close(flown[key], derived[key], 1e-6, `${key} matches the readout at ${JSON.stringify(partial)}`);
    }
    assert(Number.isFinite(derived.staticMargin), "static margin should stay finite");
    return;
  }
  for (const value of ranges[index]) {
    walk(index + 1, { ...partial, [keys[index]]: value });
  }
}
walk(0, {});

const flown = sanitizeInputs(defaultPlane(), defaultLaunch()).plane;
for (const key of ["wingArea", "aspectRatio", "mass", "cg", "ac", "meanChord", "bodyLength", "tailArea", "tailArm", "inertia"]) {
  close(flown[key], defaultPlane()[key], 1e-9, `${key} survives the physics clamps`);
}

const derived = defaultPlane();
console.log(
  `Derived CG ${(derived.cg * 100).toFixed(1)} cm, AC ${(derived.neutralPoint * 100).toFixed(1)} cm, static margin ${(derived.staticMargin * 100).toFixed(0)}%`
);
console.log(
  `Wing area ${(derived.wingArea * 1e4).toFixed(0)} cm², AR ${derived.aspectRatio.toFixed(2)}, mass ${(derived.mass * 1000).toFixed(1)} g`
);

if (process.exitCode) {
  console.error("Derived-parameter checks failed.");
} else {
  console.log("Derived-parameter checks passed.");
}
