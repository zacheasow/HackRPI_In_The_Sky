import { CONFIG, simulate } from "../public/physics.js";
import { defaultLaunch, defaultPlane } from "../public/plane.js";
import { createRecorder } from "../public/telemetry.js";
import { createApp } from "../server/app.js";
import { compareSeries, getTelemetry, initTelemetry, listFlights, saveFlight, status } from "../server/tiger.js";
import { axisTicks, compareText, plotX, stallBands } from "../public/replay.js";

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }
}

const samePath = {
  summary: { distance: 10, flight_time: 2, max_height: 3 },
  samples: { t: [0, 2], x: [0, 0], y: [0, 0], speed: [1, 1], stalled: [false, false] },
};
const pulledAway = {
  summary: { distance: 7, flight_time: 1.5, max_height: 2 },
  samples: { t: [0, 2], x: [0, 2], y: [0, 0], speed: [4, 4], stalled: [false, true] },
};
const comparison = compareSeries(samePath, pulledAway, 0.5);
assert(comparison.distanceDiff === 3, "distance diff");
assert(comparison.timeDiff === 0.5, "time diff");
assert(comparison.maxHeightDiff === 1, "height diff");
assert(comparison.firstStall.a === null && comparison.firstStall.b === 2, "first stall");
assert(comparison.peakSpeed.a === 1 && comparison.peakSpeed.b === 4, "peak speed");
assert(comparison.divergeAt === 1, `divergence at ${comparison.divergeAt}`);
assert(compareSeries(samePath, samePath, 0.5).divergeAt === null, "paths that stay together do not diverge");

const plane = defaultPlane();
const launch = defaultLaunch();
const calm = { mode: "off" };
const plain = simulate(plane, launch, calm);
const tape = createRecorder();
const recorded = simulate(plane, launch, calm, { recorder: tape.recorder });
const samples = tape.samples();
const sampleCount = samples.t.length;
const payload = {
  flight_id: crypto.randomUUID(),
  label: `${plain.distance.toFixed(2)} m`,
  design_id: null,
  summary: {
    distance: plain.distance,
    flight_time: plain.flightTime,
    max_height: plain.maxHeight,
    end_reason: plain.endReason,
  },
  params: { speed: launch.speed, angleDeg: launch.angleDeg },
  samples,
};
const payloadBytes = Buffer.byteLength(JSON.stringify(payload));
console.log(`Default flight samples: ${sampleCount}, payload ${payloadBytes} bytes`);
assert(JSON.stringify(plain) === JSON.stringify(recorded), "recorder leaves the flight result unchanged");
assert(plain.distance.toFixed(2) === "12.39", "recorded default flight keeps the baseline");
const expected = plain.flightTime / CONFIG.telemetry.sampleInterval;
assert(Math.abs(sampleCount - expected) <= 3, `sample count ${sampleCount} vs ${expected.toFixed(1)}`);
assert(Math.abs(samples.t.at(-1) - plain.flightTime) < 1e-6, "samples reach the landing time");
for (const key of Object.keys(samples)) {
  assert(samples[key].length === sampleCount, `${key} column length`);
}

delete process.env.TIGERDATA_URI;
await initTelemetry();
assert(status().mode === "local" && status().configured === false && status().reachable === false, "missing URI stays local");

for (let i = 0; i < 21; i += 1) {
  const saved = await saveFlight({
    flight_id: crypto.randomUUID(),
    label: `flight-${i}`,
    summary: { distance: i, flight_time: 1, max_height: 1, end_reason: "ground" },
    params: { span: 0.36 },
    samples: { t: [0, 0.05], x: [0, i], y: [1.5, 1] },
  });
  assert(typeof saved.flight_id === "string", "save returns a flight id");
}

const listed = await listFlights(20);
assert(listed.length === 20, "local store keeps 20 flights");
assert(listed[0].label === "flight-20" && listed[0].distance === 20, "newest flight is first");
assert(listed.at(-1).label === "flight-1", "the oldest flight is dropped");
assert(!listed.some((flight) => flight.label === "flight-0"), "the dropped flight is not listed");
assert(!("samples" in listed[0]), "list stays on the summary");

const server = createApp().listen(0, "127.0.0.1");
await new Promise((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});

const columns = ["t", "x", "y", "vx", "vy", "speed", "theta", "alpha", "cl", "cd", "lift", "drag", "stalled"];

function flightBody(samples = { t: [0, 0.01], x: [0, 1] }) {
  const full = {};
  const length = samples.t.length;
  for (const key of columns) {
    if (key in samples) full[key] = samples[key];
    else full[key] = Array.from({ length }, () => (key === "stalled" ? false : 0));
  }
  return {
    flight_id: crypto.randomUUID(),
    label: "check",
    design_id: null,
    summary: { distance: 1, flight_time: 0.01, max_height: 1.5, end_reason: "ground" },
    params: { span: 0.36 },
    samples: full,
  };
}

try {
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/health`);
  const health = await response.json();
  assert(response.status === 200, "health status");
  assert(health.telemetry.configured === false, "health telemetry is not configured");
  assert(health.telemetry.reachable === false, "health telemetry is not reachable");
  assert(health.telemetry.mode === "local", "health telemetry mode is local");
  assert(!JSON.stringify(health).includes("TIGERDATA_URI"), "health does not name the telemetry URI");

  const post = async (body, raw) => {
    const posted = await fetch(`${base}/api/flights`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw ?? JSON.stringify(body),
    });
    return { status: posted.status, json: await posted.json() };
  };

  const accepted = await post(payload);
  assert(accepted.status === 200 && accepted.json.flight_id === payload.flight_id, "valid flight is stored");

  const badUuid = flightBody();
  badUuid.flight_id = "not-a-uuid";
  assert((await post(badUuid)).status === 400, "bad uuid is rejected");

  const tooMany = flightBody({ t: Array(5001).fill(0) });
  const capped = await post(tooMany);
  assert(capped.status === 400, `too many samples status ${capped.status}`);

  const mismatch = flightBody({ t: [0, 0.01], x: [0] });
  assert((await post(mismatch)).status === 400, "mismatched columns are rejected");

  const raw = JSON.stringify(flightBody({ t: [1, 2] })).replace('"t":[1,2]', '"t":[1e309,2]');
  assert((await post(null, raw)).status === 400, "non-finite samples are rejected");

  const after = await listFlights(20);
  assert(after.some((flight) => flight.flight_id === payload.flight_id), "accepted flight is listed");
  assert(!after.some((flight) => flight.flight_id === badUuid.flight_id), "rejected flight is not listed");

  const bucketId = crypto.randomUUID();
  await saveFlight({
    flight_id: bucketId,
    label: "buckets",
    created_at: "2020-01-01T00:00:00.000Z",
    summary: { distance: 1, flight_time: 0.09, max_height: 1, end_reason: "ground" },
    samples: {
      t: [0, 0.02, 0.04, 0.05, 0.09],
      x: [0, 2, 4, 10, 20],
      y: [1, 1, 1, 1, 1],
      stalled: [false, true, false, false, true],
    },
  });
  const buckets = await getTelemetry(bucketId, 0.05);
  assert(buckets.t.length === 2, "0.05 s buckets");
  assert(Math.abs(buckets.t[0] - 0.02) < 1e-9 && Math.abs(buckets.x[0] - 2) < 1e-9, "first bucket average");
  assert(Math.abs(buckets.t[1] - 0.07) < 1e-9 && Math.abs(buckets.x[1] - 15) < 1e-9, "second bucket average");
  assert(buckets.stalled[0] === true && buckets.stalled[1] === true, "stalled is true if any sample in the bucket stalled");
  for (const key of columns) assert(buckets[key].length === buckets.t.length, `bucket column ${key}`);

  const listed = await fetch(`${base}/api/flights?limit=20`);
  const listBody = await listed.json();
  assert(listed.status === 200 && listBody.flights.some((flight) => flight.flight_id === bucketId), "list route returns the flight");
  assert(!("samples" in listBody.flights[0]), "list route omits samples");

  const tele = await fetch(`${base}/api/flights/${bucketId}/telemetry?resolution=0.05`);
  const teleBody = await tele.json();
  assert(tele.status === 200 && teleBody.x[0] === buckets.x[0] && teleBody.t.length === 2, "telemetry route matches the bucket rule");

  const badTele = await fetch(`${base}/api/flights/not-a-uuid/telemetry`);
  assert(badTele.status === 400, "bad telemetry uuid");
  const missingTele = await fetch(`${base}/api/flights/00000000-0000-0000-0000-000000000000/telemetry`);
  assert(missingTele.status === 404, "unknown telemetry id");

  const otherId = crypto.randomUUID();
  await saveFlight({
    flight_id: otherId,
    label: "other",
    created_at: "2020-01-01T00:00:00.000Z",
    summary: { distance: 4, flight_time: 0.09, max_height: 1, end_reason: "ground" },
    params: { span: 0.2, rootChord: 0.07, tipChord: 0.04, sweepDeg: 5, tailArea: 0.006, noseWeight: 1, speed: 4, angleDeg: 3 },
    samples: { t: [0, 0.09], x: [0, 3], y: [1, 1], stalled: [true, true], speed: [2, 2] },
  });
  const compared = await fetch(`${base}/api/compare?a=${bucketId}&b=${otherId}&resolution=0.05`);
  const comparedBody = await compared.json();
  assert(compared.status === 200 && comparedBody.comparison.distanceDiff === -3, "compare route returns the diff");
  assert(comparedBody.a.t.length === comparedBody.a.x.length && comparedBody.b.t.length === comparedBody.b.x.length, "compare series are columnar");
  const badCompare = await fetch(`${base}/api/compare?a=nope&b=${bucketId}`);
  assert(badCompare.status === 400, "compare rejects a bad uuid");
  const missingCompare = await fetch(`${base}/api/compare?a=${bucketId}&b=00000000-0000-0000-0000-000000000000`);
  assert(missingCompare.status === 404, "compare misses an unknown id");

  const doomed = flightBody();
  assert((await post(doomed)).status === 200, "flight to delete is stored");
  const remove = async (id, token) => {
    const headers = {};
    if (token != null) headers["x-admin-token"] = token;
    const removed = await fetch(`${base}/api/flights/${id}`, { method: "DELETE", headers });
    return removed.status;
  };
  const previousToken = process.env.ADMIN_TOKEN;
  delete process.env.ADMIN_TOKEN;
  assert(await remove(doomed.flight_id, "anything") === 403, "delete without ADMIN_TOKEN is forbidden");
  process.env.ADMIN_TOKEN = "test-admin";
  assert(await remove(doomed.flight_id, "nope") === 403, "wrong admin token is forbidden");
  assert(await remove(doomed.flight_id, "test-admin") === 200, "correct admin token deletes the flight");
  assert((await fetch(`${base}/api/flights/${doomed.flight_id}/telemetry`)).status === 404, "deleted flight telemetry is gone");
  assert(!(await listFlights(50)).some((flight) => flight.flight_id === doomed.flight_id), "deleted flight leaves the list");
  if (previousToken == null) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = previousToken;
} finally {
  await new Promise((resolve) => server.close(resolve));
}

const stallTimes = [0, 0.25, 0.5, 0.65, 0.8, 1.2, 2];
const stallFlags = [false, false, true, true, true, false, false];
const bands = stallBands(stallTimes, stallFlags);
assert(bands.length === 1 && bands[0].start === 0.5 && bands[0].end === 0.8, "stall shade covers only 0.5 s to 0.8 s");
assert(stallBands(stallTimes, stallFlags.map(() => false)).length === 0, "a flight that did not stall is not shaded");
assert(stallBands([0, 1, 2], ["t", "t", "t"]).length === 0, "non-boolean stall flags do not shade the chart");
const stallLeft = plotX(0.5, 0, 2, 40, 200);
const stallRight = plotX(0.8, 0, 2, 40, 200);
assert(Math.abs(stallLeft - 90) < 1e-6 && Math.abs(stallRight - 120) < 1e-6, "stall band uses the time axis");
assert(stallLeft > 40 && stallRight < 240, "a mid-flight stall does not cover the chart");
for (const [min, max] of [[0, 4.93], [0, 1.74], [1.5, 3.6]]) {
  const ticks = axisTicks(min, max);
  assert(ticks.length >= 4 && ticks.length <= 6, `axis from ${min} to ${max} has ${ticks.length} ticks`);
  assert(ticks[0] <= min + 1e-6 && ticks.at(-1) >= max - 1e-6, `axis from ${min} to ${max} covers the data`);
}

const named = compareText({
  labels: { a: "16.19 m", b: "3.90 m" },
  comparison: {
    distanceDiff: 12.28,
    firstStall: { a: null, b: 0.5 },
    peakSpeed: { a: 3.3, b: 3.7 },
    divergeAt: 1.05,
  },
}, { a: 16.19, b: 3.9 });
assert(named === "Flight A flew 12.28 m farther (16.19 m vs 3.90 m). Flight B stalled at 0.5 s; Flight A did not stall. Peak speed: A 3.3 m/s, B 3.7 m/s. Paths diverged at 1.05 s.", "distance labels read as Flight A and Flight B");
assert(compareText({
  labels: { a: "glider", b: "dart" },
  comparison: { distanceDiff: 3.02, firstStall: { a: null, b: null }, peakSpeed: { a: 4, b: 8.9 }, divergeAt: 0.11 },
}, { a: 12.39, b: 9.37 }).startsWith("Glider flew 3.02 m farther (12.39 m vs 9.37 m). Neither flight stalled."), "named flights keep their labels");

if (!process.exitCode) console.log("Telemetry checks passed.");
