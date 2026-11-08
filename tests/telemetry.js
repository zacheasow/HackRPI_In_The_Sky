import { createApp } from "../server/app.js";
import { initTelemetry, listFlights, saveFlight, status } from "../server/tiger.js";

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }
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

try {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
  const health = await response.json();
  assert(response.status === 200, "health status");
  assert(health.telemetry.configured === false, "health telemetry is not configured");
  assert(health.telemetry.reachable === false, "health telemetry is not reachable");
  assert(health.telemetry.mode === "local", "health telemetry mode is local");
  assert(!JSON.stringify(health).includes("TIGERDATA_URI"), "health does not name the telemetry URI");
} finally {
  await new Promise((resolve) => server.close(resolve));
}

if (!process.exitCode) console.log("Telemetry checks passed.");
