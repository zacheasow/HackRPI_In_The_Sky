import { CONFIG, simulate } from "../public/physics.js";
import { defaultLaunch, defaultPlane } from "../public/plane.js";
import { createRecorder } from "../public/telemetry.js";
import { createApp } from "../server/app.js";
import { compareSeries, getTelemetry, initTelemetry, listFlights, saveFlight, status } from "../server/tiger.js";

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
} finally {
  await new Promise((resolve) => server.close(resolve));
}

if (!process.exitCode) console.log("Telemetry checks passed.");
