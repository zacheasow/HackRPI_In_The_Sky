import { diagnose } from "../public/diagnosis.js";
import { simulate } from "../public/physics.js";
import { defaultLaunch, defaultShape, derivePlane } from "../public/plane.js";
import { createApp } from "../server/app.js";

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }
}

function flight(shape, launch) {
  const plane = derivePlane(shape);
  const result = simulate(plane, launch, { mode: "off" });
  const note = diagnose(result, plane, launch);
  let peakSpeed = 0;
  for (const sample of result.samples) {
    const speed = Math.hypot(sample.vx, sample.vy);
    if (speed > peakSpeed) peakSpeed = speed;
  }
  return {
    params: {
      span: shape.span,
      rootChord: shape.rootChord,
      tipChord: shape.tipChord,
      sweepDeg: shape.sweepDeg,
      tailArea: shape.tailArea,
      noseWeight: shape.noseWeight,
      speed: launch.speed,
      angleDeg: launch.angleDeg,
    },
    derived: {
      wingArea: plane.wingArea,
      aspectRatio: plane.aspectRatio,
      mass: plane.mass,
      cg: plane.cg,
      ac: plane.neutralPoint,
      staticMargin: plane.staticMargin,
      meanChord: plane.meanChord,
      tailArm: plane.tailArm,
    },
    result: {
      distance: result.distance,
      flightTime: result.flightTime,
      maxHeight: result.maxHeight,
      endReason: result.endReason,
      stalled: result.stalled,
      stallTime: result.stallTime,
      blownBack: result.blownBack,
      peakSpeed,
    },
    wind: { mode: "off", steady: 0 },
    diagnosis: { headline: note.headline, details: note.details, tags: note.tags },
  };
}

function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  return new Promise((resolve, reject) => {
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

async function post(base, body) {
  const response = await fetch(`${base}/api/coach`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const shape = defaultShape();
const launch = defaultLaunch();
const body = flight(shape, launch);
let seen = null;
const server = await listen(createApp({
  coach(brief) {
    seen = brief;
    return {
      explanation: "  <b>The margin stayed positive</b>, so it glided.  ",
      suggestions: [
        { parameter: "span", change: 1, reason: "a wider wing" },
        { parameter: "not-a-parameter", change: 2, reason: "ignore me" },
        { parameter: "noseWeight", change: -0.2, reason: "a little less nose" },
      ],
    };
  },
}));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  const wide = flight({ ...shape, span: 0.4 }, launch);
  const clamped = await post(base, wide);
  assert(clamped.status === 200 && clamped.body.ok === true, "coach accepts a flight");
  assert(clamped.body.explanation === "The margin stayed positive, so it glided.", "explanation is cleaned");
  assert(!JSON.stringify(clamped.body).includes("<b>"), "html is stripped");
  assert(clamped.body.suggestions.length === 2, "unknown parameter is dropped");
  assert(clamped.body.suggestions[0].parameter === "span" && Math.abs(clamped.body.suggestions[0].change - 0.02) < 1e-6, "span change is clamped to the editor max");
  assert(clamped.body.suggestions.every((item) => item.parameter !== "not-a-parameter"), "unknown parameter stays out");

  const extra = await post(base, { ...body, note: "nope" });
  assert(extra.status === 400 && extra.body.ok === false, "unknown field is rejected");

  const missing = await post(base, { params: body.params, derived: body.derived, result: body.result, wind: body.wind });
  assert(missing.status === 400, "missing diagnosis is rejected");

  const other = flight({ ...shape, noseWeight: 4 }, { ...launch, speed: 7, angleDeg: 4 });
  const compared = await post(base, { ...body, comparison: { a: body, b: other } });
  assert(compared.status === 200 && seen.comparison.a.params.noseWeight !== seen.comparison.b.params.noseWeight, "comparison is accepted");
} finally {
  await new Promise((resolve) => server.close(resolve));
}

const throwing = await listen(createApp({
  coach() {
    throw new Error("coach-secret-should-not-leak");
  },
}));
try {
  const down = await post(`http://127.0.0.1:${throwing.address().port}`, body);
  assert(down.status === 503 && down.body.ok === false, "model errors return 503");
  assert(!JSON.stringify(down.body).includes("coach-secret-should-not-leak"), "model errors stay off the response");
} finally {
  await new Promise((resolve) => throwing.close(resolve));
}

const savedKey = process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEY;
const offline = await listen(createApp());
try {
  const missingKey = await post(`http://127.0.0.1:${offline.address().port}`, body);
  assert(missingKey.status === 503 && missingKey.body.ok === false, "a missing key returns 503");
} finally {
  if (savedKey) process.env.GEMINI_API_KEY = savedKey;
  await new Promise((resolve) => offline.close(resolve));
}

if (!process.exitCode) console.log("Coach checks passed.");
