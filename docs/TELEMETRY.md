# Aerogami flight telemetry (Tiger Data)

Every manual flight's per-timestep data is stored in a TimescaleDB hypertable on Tiger Cloud (Postgres + TimescaleDB). The frontend gets a Flights tab with Replay and Compare. MongoDB stays as-is for the design leaderboard; Tiger Data is only for telemetry. **The physics must not change.** Baselines (wind off): default glider 12.39 m, 7 m/s at 4 deg 16.45 m.

Build one stage at a time. After each stage: npm test passes, baselines unchanged, then stop and report.

## Environment

- `TIGERDATA_URI` in `.env` (already set locally; never commit it). Add `TIGERDATA_URI=` (blank) with a comment to `.env.example`.
- Use the `pg` package with one `Pool`. SSL: `ssl: { rejectUnauthorized: false }` unless the URI sets its own sslmode handling. Pool max 5, connection timeout 3 s.
- Never send the URI to the browser and never log it (log only "telemetry: connected" / "telemetry: local mode (reason)").
- `/api/health` gains `telemetry: { configured: bool, reachable: bool, mode: "tiger" | "local" }`.

## Storage interface (server/tiger.js)

One module, two backends behind the same functions, so every route works with or without the database:

- `initTelemetry()` connect + schema; on any failure, switch to local mode, never crash.
- `saveFlight({ flight_id, design_id, label, summary, params, samples })` returns `{ flight_id }`
- `listFlights(limit)`
- `getTelemetry(flight_id, resolution)`
- `status()`

Local mode: an in-memory capped array of the last 20 flights (oldest dropped), with downsampling done in JS using the same bucket rule as SQL.

## Schema (idempotent, run in initTelemetry)

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;  -- usually preinstalled on Tiger Cloud; a failure here is a WARNING, continue

CREATE TABLE IF NOT EXISTS flights (
  flight_id   uuid PRIMARY KEY,
  design_id   text,              -- MongoDB design _id (hex) if submitted, else null
  label       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  distance    double precision,
  flight_time double precision,
  max_height  double precision,
  end_reason  text,
  params      jsonb
);

CREATE TABLE IF NOT EXISTS flight_telemetry (
  ts        timestamptz NOT NULL,   -- flight created_at + t seconds
  flight_id uuid NOT NULL,
  t         double precision NOT NULL,
  x double precision, y double precision,
  vx double precision, vy double precision,
  speed double precision,
  theta double precision,  -- pitch
  alpha double precision,  -- angle of attack
  cl double precision, cd double precision,
  lift double precision, drag double precision,
  stalled boolean
);

SELECT create_hypertable('flight_telemetry', 'ts', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_telemetry_flight_t ON flight_telemetry (flight_id, t);
```

If `create_hypertable` fails, log a clear error and use local mode.

## Downsampling

`time_bucket` does NOT accept a double column, so never bucket on `t`. Use:

```sql
SELECT time_bucket(make_interval(secs => $2), ts) AS bucket,
       avg(t) AS t, avg(x) AS x, avg(y) AS y, avg(vx) AS vx, avg(vy) AS vy,
       avg(speed) AS speed, avg(theta) AS theta, avg(alpha) AS alpha,
       avg(cl) AS cl, avg(cd) AS cd, avg(lift) AS lift, avg(drag) AS drag,
       bool_or(stalled) AS stalled
FROM flight_telemetry WHERE flight_id = $1
GROUP BY bucket ORDER BY bucket;
```

Resolution in seconds: default 0.05, min 0.01, max 1. Responses are column-oriented: `{ t:[...], x:[...], ... }`.

## Recording (public/physics.js + public/telemetry.js)

- Add an optional `recorder` callback to the simulate options. **Off by default.** When absent, the code path and results are byte-for-byte identical. Add a test: default flight with and without a recorder gives exactly the same result object.
- Sample every `CONFIG.telemetry.sampleInterval` seconds (default 0.01). Fields: t, x, y, vx, vy, speed, theta, alpha, cl, cd, lift, drag, stalled. physics.js already computes alpha and wing CL/CD (wingCoefficients); expose what exists, send null for anything not computed.
- Only manual flights from the Fly page pass a recorder. Auto-tune, the landing preview, the seed script's tuning, and tests never record unless they explicitly ask.
- After each manual flight, public/telemetry.js POSTs the flight. flight_id = `crypto.randomUUID()` on the client. If the flight is later submitted to the leaderboard, PATCH-free approach: the client sends design_id in the POST if it already has one, otherwise null.

## Routes

- `POST /api/flights` body `{ flight_id, label, design_id?, summary, params, samples }`. samples is column-oriented. Validate: uuid format, label max 24 chars (strip HTML), max **5,000** samples, every value finite or null, all columns same length. Body limit **512 kb on this route only**; keep the global 16 kb. Rate limit 30/min. Insert the flights row and samples in ONE transaction, batches of 1,000 rows via `unnest()`. Returns `{ flight_id }`.
- `GET /api/flights?limit=20` (1-50) newest first, summary fields only.
- `GET /api/flights/:id/telemetry?resolution=0.05`
- `GET /api/compare?a=&b=&resolution=0.05` both downsampled series plus `comparison`: distance diff, flight-time diff, max-height diff, first stall time for each (null if none), peak speed for each, and divergence time (first t where the two paths, interpolated on a shared t grid, are more than 0.5 m apart; null if never).

## Frontend (public/replay.js)

- "Flights" tab in sim.html next to Results / History / Coach. List: label, distance, time, end reason, with Replay and a Compare checkbox (max two). Badge "telemetry: local mode" when health says local.
- Replay: plane follows stored x, y, theta in the existing renderer (reuse render.js, no physics). Play/pause, scrubber, speed 0.25x / 0.5x / 1x / 2x.
- Charts in plain canvas (no libraries): altitude, speed, angle of attack vs t, a vertical cursor synced to the scrubber, and shaded stalled regions.
- Compare: both trajectories overlaid (A blue, B orange, legend), ghosts replayed on a shared clock, the same three charts overlaid, and a comparison card (who flew farther and by how much, who stalled first, peak speeds, where the paths diverged).
- "Ask the coach to compare" sends `comparison` plus both params to the existing `/api/coach` (it already accepts an optional `comparison` field) and shows the result in the Coach tab.
- No gradients outside the canvas. Keep the existing palette.

## Seed script

`npm run seed` (scripts/seed.js): runs 5 flights with different shapes and launches using the real physics in node, records telemetry, saves them through the same storage interface (Tiger if reachable, otherwise prints that it's in local mode and exits, since memory won't persist).

## Tests

tests/telemetry.js: local-mode backend (no network). Covers validation and caps, the column length mismatch rejection, the downsampling rule, compare math (divergence, first stall), and the recorder-doesn't-change-results check. Add it to npm test.

## Stages

1. server/tiger.js (storage interface, both backends, schema, health), `pg` dependency, .env.example, seed script skeleton.
2. Recorder in physics.js + public/telemetry.js + POST /api/flights.
3. GET routes with downsampling (SQL + local).
4. Flights tab + single-flight Replay + charts.
5. Compare view + /api/compare.
6. Coach comparison button, README section (TIGERDATA_URI, how to create a Tiger Cloud service), final polish.
