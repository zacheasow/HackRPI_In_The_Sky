import express from "express";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { prepareEntry, publicEntry, readLimit } from "./board.js";
import { getCollection, ping } from "./db.js";
import { designsLimiter } from "./limits.js";

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

export function createApp(options = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "16kb" }));
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
    });
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
      await scores.insertOne({ ...entry, createdAt });
      const ahead = await scores.countDocuments({
        $or: [
          { distance: { $gt: entry.distance } },
          { distance: entry.distance, createdAt: { $lt: createdAt } },
        ],
      });
      res.json({ ok: true, rank: ahead + 1, distance: entry.distance });
    } catch {
      console.error("Leaderboard database unavailable");
      res.status(503).json({ ok: false });
    }
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
