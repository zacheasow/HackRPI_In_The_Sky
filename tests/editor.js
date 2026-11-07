import { SHAPE_LIMITS, defaultShape } from "../public/plane.js";
import { HANDLES, handlePosition, shapeFromHandle } from "../public/editor.js";

const MM = 1e-4;

const FIELD = {
  span: "span",
  rootChord: "rootChord",
  tipChord: "tipChord",
  sweep: "sweepDeg",
  tail: "tailArea",
};

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }
}

function close(actual, expected, epsilon, message) {
  assert(Math.abs(actual - expected) <= epsilon, `${message}: got ${actual}, expected ${expected}`);
}

function apart(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

const shapes = [
  defaultShape(),
  {
    span: SHAPE_LIMITS.span[0],
    rootChord: SHAPE_LIMITS.rootChord[0],
    tipChord: SHAPE_LIMITS.tipChord[0],
    sweepDeg: SHAPE_LIMITS.sweepDeg[0],
    tailArea: SHAPE_LIMITS.tailArea[0],
    noseWeight: SHAPE_LIMITS.noseWeight[0],
  },
  {
    span: SHAPE_LIMITS.span[1],
    rootChord: SHAPE_LIMITS.rootChord[1],
    tipChord: SHAPE_LIMITS.tipChord[1],
    sweepDeg: SHAPE_LIMITS.sweepDeg[1],
    tailArea: SHAPE_LIMITS.tailArea[1],
    noseWeight: SHAPE_LIMITS.noseWeight[1],
  },
  { span: 0.28, rootChord: 0.09, tipChord: 0.06, sweepDeg: 18, tailArea: 0.004, noseWeight: 3 },
];

for (const shape of shapes) {
  for (const handle of HANDLES) {
    const point = handlePosition(shape, handle);
    const next = shapeFromHandle(shape, handle, point);
    const again = handlePosition(next, handle);
    const key = FIELD[handle];
    close(again.x, point.x, MM, `${handle} x round trip`);
    close(again.y, point.y, MM, `${handle} y round trip`);
    close(next[key], shape[key], MM, `${handle} value round trip`);
    assert(apart(point, again) <= MM, `${handle} moved ${apart(point, again)} m`);
    for (const other of Object.keys(shape)) {
      if (other === key) continue;
      assert(next[other] === shape[other], `${handle} changed ${other}`);
    }
    assert(shape[key] === shapes.find((item) => item === shape)[key], `${handle} mutated the input`);
  }
}

const base = defaultShape();
const original = defaultShape();

assert(shapeFromHandle(base, "span", { x: 0, y: 10 }).span === SHAPE_LIMITS.span[1], "span clamps high");
assert(shapeFromHandle(base, "span", { x: 0, y: 0 }).span === SHAPE_LIMITS.span[0], "span clamps low");
close(shapeFromHandle(base, "span", { x: 1, y: -0.1 }).span, 0.2, 1e-12, "mirrored wingtip");

assert(
  shapeFromHandle(base, "rootChord", { x: 5, y: 1 }).rootChord === SHAPE_LIMITS.rootChord[1],
  "root chord clamps high"
);
assert(
  shapeFromHandle(base, "rootChord", { x: 0, y: 0 }).rootChord === SHAPE_LIMITS.rootChord[0],
  "root chord clamps low"
);
assert(
  shapeFromHandle(base, "tipChord", { x: 5, y: 0 }).tipChord === SHAPE_LIMITS.tipChord[1],
  "tip chord clamps high"
);
assert(
  shapeFromHandle(base, "tipChord", { x: -1, y: 0 }).tipChord === SHAPE_LIMITS.tipChord[0],
  "tip chord clamps low"
);
assert(shapeFromHandle(base, "sweep", { x: 5, y: 0 }).sweepDeg === SHAPE_LIMITS.sweepDeg[1], "sweep clamps high");
assert(shapeFromHandle(base, "sweep", { x: -1, y: 0 }).sweepDeg === SHAPE_LIMITS.sweepDeg[0], "sweep clamps low");
assert(shapeFromHandle(base, "tail", { x: 5, y: 1 }).tailArea === SHAPE_LIMITS.tailArea[1], "tail clamps high");
assert(shapeFromHandle(base, "tail", { x: 0, y: 0 }).tailArea === SHAPE_LIMITS.tailArea[0], "tail clamps low");
assert(shapeFromHandle(base, "span", { y: NaN }).span === base.span, "non-finite drag keeps the current value");
assert(base.span === original.span && base.sweepDeg === original.sweepDeg, "conversion does not mutate the shape");

if (!process.exitCode) {
  console.log("Handle round trip within 0.1 mm, clamps hold.");
  console.log("Editor checks passed.");
}
