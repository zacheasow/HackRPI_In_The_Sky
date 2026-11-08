import { Pool } from "pg";

const LOCAL_CAP = 20;
const FIELDS = ["t", "x", "y", "vx", "vy", "speed", "theta", "alpha", "cl", "cd", "lift", "drag", "stalled"];

const localFlights = [];
let mode = "local";
let reachable = false;
let pool = null;
let starting = null;

function uri() {
  const value = process.env.TIGERDATA_URI;
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function status() {
  return {
    configured: Boolean(uri()),
    reachable: reachable && mode === "tiger",
    mode,
  };
}

function useLocal(reason) {
  const current = pool;
  const quiet = mode === "local" && !current;
  mode = "local";
  reachable = false;
  pool = null;
  if (current) current.end().catch(() => {});
  if (!quiet) console.log(`telemetry: local mode (${reason})`);
}

function poolConfig(connectionString) {
  const config = {
    connectionString,
    max: 5,
    connectionTimeoutMillis: 3000,
  };
  if (!/sslmode=disable/i.test(connectionString)) {
    config.ssl = { rejectUnauthorized: false };
  }
  return config;
}

async function ensureSchema(db) {
  try {
    await db.query("CREATE EXTENSION IF NOT EXISTS timescaledb");
  } catch {
    console.warn("telemetry: timescaledb extension unavailable");
  }
  await db.query(`
    CREATE TABLE IF NOT EXISTS flights (
      flight_id   uuid PRIMARY KEY,
      design_id   text,
      created_at  timestamptz NOT NULL DEFAULT now(),
      label       text,
      distance    double precision,
      flight_time double precision,
      max_height  double precision,
      end_reason  text,
      params      jsonb
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS flight_telemetry (
      ts        timestamptz NOT NULL,
      flight_id uuid NOT NULL,
      t         double precision NOT NULL,
      x double precision, y double precision,
      vx double precision, vy double precision,
      speed double precision,
      theta double precision,
      alpha double precision,
      cl double precision, cd double precision,
      lift double precision, drag double precision,
      stalled boolean
    )
  `);
  try {
    await db.query("SELECT create_hypertable('flight_telemetry', 'ts', if_not_exists => TRUE)");
  } catch {
    const error = new Error("hypertable");
    error.code = "HYPERTABLE";
    throw error;
  }
  await db.query("CREATE INDEX IF NOT EXISTS idx_telemetry_flight_t ON flight_telemetry (flight_id, t)");
}

export function initTelemetry() {
  if (starting) return starting;
  starting = (async () => {
    const connectionString = uri();
    if (!connectionString) {
      console.log("telemetry: local mode (not configured)");
      return status();
    }
    try {
      const next = new Pool(poolConfig(connectionString));
      next.on("error", () => {
        if (mode === "tiger") useLocal("unavailable");
      });
      pool = next;
      await pool.query("SELECT 1");
      await ensureSchema(pool);
      mode = "tiger";
      reachable = true;
      console.log("telemetry: connected");
    } catch (error) {
      useLocal(error?.code === "HYPERTABLE" ? "hypertable failed" : "unavailable");
    }
    return status();
  })();
  return starting;
}

function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 20;
  return Math.min(50, Math.max(1, Math.floor(n)));
}

function clampResolution(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.05;
  return Math.min(1, Math.max(0.01, n));
}

function summaryOf(flight) {
  const summary = flight.summary || {};
  return {
    flight_id: flight.flight_id,
    design_id: flight.design_id ?? null,
    label: flight.label ?? null,
    created_at: flight.created_at,
    distance: summary.distance ?? null,
    flight_time: summary.flight_time ?? null,
    max_height: summary.max_height ?? null,
    end_reason: summary.end_reason ?? null,
  };
}

function columnSamples(samples) {
  const source = samples && typeof samples === "object" ? samples : {};
  const length = Array.isArray(source.t) ? source.t.length : 0;
  const columns = {};
  for (const key of FIELDS) {
    const values = Array.isArray(source[key]) ? source[key] : [];
    columns[key] = Array.from({ length }, (_, index) => values[index] ?? null);
  }
  return columns;
}

function downsample(samples, createdAt, resolution) {
  const columns = columnSamples(samples);
  const origin = new Date(createdAt).getTime();
  const size = resolution * 1000;
  const groups = new Map();
  for (let index = 0; index < columns.t.length; index += 1) {
    const stamp = origin + Number(columns.t[index] || 0) * 1000;
    const bucket = Math.floor(stamp / size) * size;
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(index);
  }
  const out = Object.fromEntries(FIELDS.map((key) => [key, []]));
  for (const bucket of [...groups.keys()].sort((a, b) => a - b)) {
    const indexes = groups.get(bucket);
    for (const key of FIELDS) {
      if (key === "stalled") {
        out.stalled.push(indexes.some((index) => columns.stalled[index] === true));
        continue;
      }
      const nums = indexes.map((index) => Number(columns[key][index])).filter(Number.isFinite);
      out[key].push(nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : null);
    }
  }
  return out;
}

function saveLocal(flight) {
  const flight_id = flight?.flight_id || crypto.randomUUID();
  const stored = {
    ...flight,
    flight_id,
    created_at: flight?.created_at || new Date().toISOString(),
  };
  const existing = localFlights.findIndex((item) => item.flight_id === flight_id);
  if (existing >= 0) localFlights.splice(existing, 1);
  localFlights.push(stored);
  while (localFlights.length > LOCAL_CAP) localFlights.shift();
  return { flight_id };
}

async function saveTiger(flight) {
  const flight_id = flight.flight_id || crypto.randomUUID();
  const createdAt = flight.created_at || new Date().toISOString();
  const summary = flight.summary || {};
  const columns = columnSamples(flight.samples);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO flights (flight_id, design_id, label, created_at, distance, flight_time, max_height, end_reason, params)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (flight_id) DO UPDATE SET
         design_id = EXCLUDED.design_id,
         label = EXCLUDED.label,
         distance = EXCLUDED.distance,
         flight_time = EXCLUDED.flight_time,
         max_height = EXCLUDED.max_height,
         end_reason = EXCLUDED.end_reason,
         params = EXCLUDED.params`,
      [
        flight_id,
        flight.design_id ?? null,
        flight.label ?? null,
        createdAt,
        summary.distance ?? null,
        summary.flight_time ?? null,
        summary.max_height ?? null,
        summary.end_reason ?? null,
        flight.params ?? null,
      ]
    );
    await client.query("DELETE FROM flight_telemetry WHERE flight_id = $1", [flight_id]);
    const origin = new Date(createdAt).getTime();
    for (let start = 0; start < columns.t.length; start += 1000) {
      const end = Math.min(columns.t.length, start + 1000);
      const slice = (key) => columns[key].slice(start, end);
      const ts = slice("t").map((t) => new Date(origin + Number(t || 0) * 1000));
      await client.query(
        `INSERT INTO flight_telemetry
           (ts, flight_id, t, x, y, vx, vy, speed, theta, alpha, cl, cd, lift, drag, stalled)
         SELECT * FROM unnest(
           $1::timestamptz[], $2::uuid[], $3::float8[], $4::float8[], $5::float8[],
           $6::float8[], $7::float8[], $8::float8[], $9::float8[], $10::float8[],
           $11::float8[], $12::float8[], $13::float8[], $14::float8[], $15::boolean[]
         )`,
        [
          ts,
          Array(end - start).fill(flight_id),
          slice("t"),
          slice("x"),
          slice("y"),
          slice("vx"),
          slice("vy"),
          slice("speed"),
          slice("theta"),
          slice("alpha"),
          slice("cl"),
          slice("cd"),
          slice("lift"),
          slice("drag"),
          slice("stalled"),
        ]
      );
    }
    await client.query("COMMIT");
    return { flight_id };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function saveFlight(flight) {
  if (mode !== "tiger" || !pool) return saveLocal(flight);
  try {
    return await saveTiger(flight);
  } catch {
    useLocal("unavailable");
    return saveLocal(flight);
  }
}

export async function listFlights(limit = 20) {
  const count = clampLimit(limit);
  if (mode !== "tiger" || !pool) {
    return localFlights.slice(-count).reverse().map(summaryOf);
  }
  try {
    const result = await pool.query(
      `SELECT flight_id, design_id, label, created_at, distance, flight_time, max_height, end_reason
       FROM flights ORDER BY created_at DESC LIMIT $1`,
      [count]
    );
    return result.rows;
  } catch {
    useLocal("unavailable");
    return localFlights.slice(-count).reverse().map(summaryOf);
  }
}

const TELEMETRY_SQL = `
  SELECT time_bucket(make_interval(secs => $2), ts) AS bucket,
         avg(t) AS t, avg(x) AS x, avg(y) AS y, avg(vx) AS vx, avg(vy) AS vy,
         avg(speed) AS speed, avg(theta) AS theta, avg(alpha) AS alpha,
         avg(cl) AS cl, avg(cd) AS cd, avg(lift) AS lift, avg(drag) AS drag,
         bool_or(stalled) AS stalled
  FROM flight_telemetry WHERE flight_id = $1
  GROUP BY bucket ORDER BY bucket
`;

function columnsFromRows(rows) {
  const out = Object.fromEntries(FIELDS.map((key) => [key, []]));
  for (const row of rows) {
    for (const key of FIELDS) out[key].push(row[key] ?? null);
  }
  return out;
}

export async function getTelemetry(flightId, resolution) {
  const step = clampResolution(resolution);
  if (mode !== "tiger" || !pool) {
    const flight = localFlights.find((item) => item.flight_id === flightId);
    if (!flight) return null;
    return downsample(flight.samples, flight.created_at, step);
  }
  try {
    const result = await pool.query(TELEMETRY_SQL, [flightId, step]);
    if (result.rows.length === 0) return null;
    return columnsFromRows(result.rows);
  } catch {
    useLocal("unavailable");
    const flight = localFlights.find((item) => item.flight_id === flightId);
    if (!flight) return null;
    return downsample(flight.samples, flight.created_at, step);
  }
}
