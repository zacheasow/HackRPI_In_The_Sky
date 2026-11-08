import dotenv from "dotenv";
import { defaultLaunch, defaultShape, derivePlane } from "../public/plane.js";
import { simulate } from "../public/physics.js";
import { createRecorder } from "../public/telemetry.js";
import { initTelemetry, saveFlight, status } from "../server/tiger.js";

dotenv.config();
await initTelemetry();
const mode = status().mode;
console.log(mode);
if (mode !== "tiger") {
  console.log("seed: local mode, nothing saved");
  process.exit(0);
}

const calm = { mode: "off" };
const flights = [
  { label: "glider", shape: defaultShape(), launch: defaultLaunch() },
  {
    label: "wide",
    shape: { ...defaultShape(), span: 0.42, sweepDeg: 0 },
    launch: { speed: 6, angleDeg: 8, height: 1.5 },
  },
  {
    label: "dart",
    shape: { ...defaultShape(), span: 0.2, rootChord: 0.12, tipChord: 0.03, sweepDeg: 20, noseWeight: 4 },
    launch: { speed: 9, angleDeg: 12, height: 1.5 },
  },
  {
    label: "floater",
    shape: { ...defaultShape(), span: 0.4, rootChord: 0.09, tipChord: 0.08, tailArea: 0.009, noseWeight: 0.2 },
    launch: { speed: 3.5, angleDeg: 1, height: 1.5 },
  },
  {
    label: "swept",
    shape: { ...defaultShape(), span: 0.3, sweepDeg: 30, noseWeight: 2 },
    launch: { speed: 7, angleDeg: 4, height: 1.5 },
  },
];

for (const flight of flights) {
  const tape = createRecorder();
  const result = simulate(derivePlane(flight.shape), flight.launch, calm, { recorder: tape.recorder });
  const saved = await saveFlight({
    flight_id: crypto.randomUUID(),
    label: flight.label,
    design_id: null,
    summary: {
      distance: result.distance,
      flight_time: result.flightTime,
      max_height: result.maxHeight,
      end_reason: result.endReason,
    },
    params: { ...flight.shape, speed: flight.launch.speed, angleDeg: flight.launch.angleDeg },
    samples: tape.samples(),
  });
  console.log(`${flight.label} ${result.distance.toFixed(2)} m ${saved.flight_id}`);
}
