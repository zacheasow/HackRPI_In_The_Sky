import express from "express";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { prepareEntry, publicEntry, readLimit } from "./board.js";
import { getCollection, ping } from "./db.js";
import { askCoach } from "./coach.js";
import { coachLimiter, deleteLimiter, designsLimiter, flightsLimiter } from "./limits.js";
import { compareFlights, deleteFlight, getTelemetry, listFlights, saveFlight, status as telemetryStatus } from "./tiger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function apiError(err, req, res, next) {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = err.status || err.statusCode;
  if (err.type === "entity.parse.failed" || status === 400) {
    res.status(400).json({ error: "Bad request" });
    return;
  }
  if (err.type === "entity.too.large" || status === 413) {
    res.status(413).json({ error: "Payload too large" });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Something went wrong" });
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function designId(value) {
  const text = value && typeof value.toHexString === "function" ? value.toHexString() : String(value ?? "");
  return /^[0-9a-f]{24}$/i.test(text) ? text.toLowerCase() : null;
}

const FLIGHT_FIELDS = ["t", "x", "y", "vx", "vy", "speed", "theta", "alpha", "cl", "cd", "lift", "drag", "stalled"];
const FLIGHT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanLabel(value) {
  const stripped = String(value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "")
    .trim();
  if (!stripped || stripped.length > 24) return stripped ? undefined : null;
  return stripped;
}

function finiteOrNull(value) {
  if (value == null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readSamples(samples) {
  if (!samples || typeof samples !== "object" || Array.isArray(samples)) return undefined;
  const length = Array.isArray(samples.t) ? samples.t.length : -1;
  if (length < 0 || length > 5000) return undefined;
  const columns = {};
  for (const key of FLIGHT_FIELDS) {
    const values = samples[key];
    if (!Array.isArray(values) || values.length !== length) return undefined;
    const clean = [];
    for (const value of values) {
      if (key === "stalled") {
        if (value == null) clean.push(null);
        else if (typeof value === "boolean") clean.push(value);
        else return undefined;
        continue;
      }
      const next = key === "t" && value == null ? undefined : finiteOrNull(value);
      if (next === undefined) return undefined;
      clean.push(next);
    }
    columns[key] = clean;
  }
  return columns;
}

function readFlight(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Bad request" };
  const flight_id = typeof body.flight_id === "string" ? body.flight_id.trim().toLowerCase() : "";
  if (!FLIGHT_UUID.test(flight_id)) return { error: "Bad request" };
  const label = cleanLabel(body.label);
  if (label === undefined) return { error: "Bad request" };
  const summary = body.summary && typeof body.summary === "object" ? body.summary : null;
  if (!summary) return { error: "Bad request" };
  const distance = finiteOrNull(summary.distance);
  const flight_time = finiteOrNull(summary.flight_time);
  const max_height = finiteOrNull(summary.max_height);
  const end_reason = cleanLabel(summary.end_reason);
  if (distance === undefined || flight_time === undefined || max_height === undefined || end_reason === undefined) {
    return { error: "Bad request" };
  }
  const samples = readSamples(body.samples);
  if (!samples) return { error: "Bad request" };
  const params = body.params && typeof body.params === "object" && !Array.isArray(body.params) ? body.params : null;
  return {
    flight_id,
    design_id: designId(body.design_id),
    label,
    summary: { distance, flight_time, max_height, end_reason },
    params,
    samples,
  };
}

export function createApp(options = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  const jsonSmall = express.json({ limit: "16kb" });
  app.use((req, res, next) => {
    if (req.method === "POST" && req.path === "/api/flights") return next();
    jsonSmall(req, res, next);
  });
  app.use(express.static(path.join(__dirname, "..", "public")));

  async function openScores() {
    if (options.offline) return null;
    if (options.collection) return options.collection;
    return getCollection();
  }

  app.get("/api/health", asyncRoute(async (req, res) => {
    const db = await ping();
    res.json({
      ok: true,
      uptime: process.uptime(),
      version,
      coach: Boolean(process.env.GEMINI_API_KEY),
      db,
      telemetry: telemetryStatus(),
    });
  }));

  app.post("/api/coach", coachLimiter, asyncRoute(async (req, res) => {
    const outcome = await askCoach(req.body, options.coach);
    if (outcome.error) {
      res.status(400).json({ ok: false, error: "Bad request" });
      return;
    }
    if (!outcome.ok) {
      res.status(503).json({ ok: false });
      return;
    }
    res.json({ ok: true, explanation: outcome.explanation, suggestions: outcome.suggestions });
  }));

  app.post("/api/designs", designsLimiter, asyncRoute(async (req, res) => {
    const entry = prepareEntry(req.body);
    if (entry.error) {
      res.status(400).json({ ok: false, error: entry.error });
      return;
    }
    const scores = await openScores();
    if (!scores) {
      res.status(503).json({ ok: false });
      return;
    }
    try {
      if (!scores.__boardIndex) {
        await scores.createIndex({ distance: -1, createdAt: 1 });
        scores.__boardIndex = true;
      }
      const createdAt = new Date();
      const inserted = await scores.insertOne({ ...entry, createdAt });
      const ahead = await scores.countDocuments({
        $or: [
          { distance: { $gt: entry.distance } },
          { distance: entry.distance, createdAt: { $lt: createdAt } },
        ],
      });
      res.json({
        ok: true,
        rank: ahead + 1,
        distance: entry.distance,
        design_id: designId(inserted && inserted.insertedId),
      });
    } catch {
      console.error("Leaderboard database unavailable");
      res.status(503).json({ ok: false });
    }
  }));

  app.get("/api/flights", asyncRoute(async (req, res) => {
    const flights = await listFlights(req.query.limit);
    res.json({ flights });
  }));

  app.get("/api/flights/:id/telemetry", asyncRoute(async (req, res) => {
    const flightId = String(req.params.id || "").trim().toLowerCase();
    if (!FLIGHT_UUID.test(flightId)) {
      res.status(400).json({ error: "Bad request" });
      return;
    }
    const series = await getTelemetry(flightId, req.query.resolution);
    if (!series) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(series);
  }));

  function adminOk(req) {
    const expected = process.env.ADMIN_TOKEN;
    if (typeof expected !== "string" || !expected) return false;
    return req.get("x-admin-token") === expected;
  }

  app.delete("/api/flights/:id", deleteLimiter, asyncRoute(async (req, res) => {
    if (!adminOk(req)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const flightId = String(req.params.id || "").trim().toLowerCase();
    if (!FLIGHT_UUID.test(flightId)) {
      res.status(400).json({ error: "Bad request" });
      return;
    }
    const removed = await deleteFlight(flightId);
    if (!removed) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ ok: true });
  }));

  app.post("/api/flights", express.json({ limit: "512kb" }), flightsLimiter, asyncRoute(async (req, res) => {
    const flight = readFlight(req.body);
    if (flight.error) {
      res.status(400).json({ ok: false, error: "Bad request" });
      return;
    }
    const saved = await saveFlight(flight);
    res.json({ flight_id: saved.flight_id });
  }));

  app.get("/api/compare", asyncRoute(async (req, res) => {
    const a = String(req.query.a || "").trim().toLowerCase();
    const b = String(req.query.b || "").trim().toLowerCase();
    if (!FLIGHT_UUID.test(a) || !FLIGHT_UUID.test(b)) {
      res.status(400).json({ error: "Bad request" });
      return;
    }
    const compared = await compareFlights(a, b, req.query.resolution);
    if (!compared) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(compared);
  }));

  app.get("/api/leaderboard", asyncRoute(async (req, res) => {
    const scores = await openScores();
    if (!scores) {
      res.json({ ok: false, entries: [] });
      return;
    }
    try {
      const limit = readLimit(req.query.limit);
      const rows = await scores.find().sort({ distance: -1, createdAt: 1 }).limit(limit).toArray();
      res.json({ ok: true, entries: rows.map(publicEntry) });
    } catch {
      console.error("Leaderboard database unavailable");
      res.json({ ok: false, entries: [] });
    }
  }));

  app.use("/api", (req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use(apiError);
  return app;
}
