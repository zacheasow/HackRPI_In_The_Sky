import express from "express";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

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

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "16kb" }));
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("/api/health", (req, res) => {
    res.json({
      ok: true,
      uptime: process.uptime(),
      version,
      coach: Boolean(process.env.GEMINI_API_KEY),
      db: Boolean(process.env.MONGODB_URI),
    });
  });

  app.use("/api", (req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use(apiError);
  return app;
}
