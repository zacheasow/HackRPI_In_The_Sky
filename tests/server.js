import { coachLimiter, designsLimiter } from "../server/limits.js";
import { createApp } from "../server/app.js";
import { readFileSync } from "fs";

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }
}

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const server = createApp().listen(0, "127.0.0.1");

await new Promise((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});

const base = `http://127.0.0.1:${server.address().port}`;

try {
  assert(typeof coachLimiter === "function" && typeof designsLimiter === "function", "limiters should be middleware");

  const healthRes = await fetch(`${base}/api/health`);
  const health = await healthRes.json();
  const healthText = JSON.stringify(health);
  console.log(`Health: ${healthRes.status} ok=${health.ok} version=${health.version}`);
  assert(healthRes.status === 200, "health status");
  assert(health.ok === true, "health ok");
  assert(health.version === version, "health version");
  assert(health.coach === Boolean(process.env.GEMINI_API_KEY), "coach flag is a boolean");
  assert(typeof health.db === "boolean", "db flag is a boolean");
  if (!process.env.MONGODB_URI) assert(health.db === false, "db is false without a URI");
  assert(!healthText.includes("GEMINI_API_KEY") && !healthText.includes("MONGODB_URI"), "health names a secret");
  for (const secret of [process.env.GEMINI_API_KEY, process.env.MONGODB_URI]) {
    if (secret) assert(!healthText.includes(secret), "health included a secret value");
  }
  assert(!healthRes.headers.has("x-powered-by"), "x-powered-by is disabled");

  const missingRes = await fetch(`${base}/api/does-not-exist`);
  const missing = await missingRes.json();
  assert(missingRes.status === 404, "unknown api status");
  assert(missingRes.headers.get("content-type").includes("application/json"), "unknown api is JSON");
  assert(missing.error === "Not found", "unknown api message");

  const oversized = await fetch(`${base}/api/health`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pad: "x".repeat(20 * 1024) }),
  });
  const oversizedBody = await oversized.json();
  assert(oversized.status === 413, `oversized status ${oversized.status}`);
  assert(oversized.headers.get("content-type").includes("application/json"), "oversized is JSON");
  assert(oversizedBody.error === "Payload too large", "oversized message");
} finally {
  await new Promise((resolve) => server.close(resolve));
}

if (!process.exitCode) console.log("Server checks passed.");
