import { clampShape } from "../public/editor.js";
import { simulate } from "../public/physics.js";
import { LAUNCH_HEIGHT, defaultShape, derivePlane } from "../public/plane.js";
import { readLimit } from "../server/board.js";
import { createApp } from "../server/app.js";

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }
}

function memoryCollection() {
  const docs = [];
  return {
    async createIndex() {},
    async insertOne(doc) {
      docs.push({ ...doc });
      return { insertedId: docs.length };
    },
    async countDocuments(filter) {
      return docs.filter((doc) => filter.$or.some((clause) => {
        if (clause.distance && clause.distance.$gt != null) return doc.distance > clause.distance.$gt;
        return doc.distance === clause.distance && new Date(doc.createdAt) < new Date(clause.createdAt.$lt);
      })).length;
    },
    find() {
      let rows = docs.map((doc) => ({ ...doc }));
      const cursor = {
        sort(spec) {
          const distanceDir = spec.distance < 0 ? -1 : 1;
          const timeDir = spec.createdAt < 0 ? -1 : 1;
          rows.sort((a, b) => {
            if (a.distance !== b.distance) return (a.distance - b.distance) * distanceDir;
            return (new Date(a.createdAt) - new Date(b.createdAt)) * timeDir;
          });
          return cursor;
        },
        limit(count) {
          rows = rows.slice(0, count);
          return cursor;
        },
        async toArray() {
          return rows;
        },
      };
      return cursor;
    },
  };
}

function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  return new Promise((resolve, reject) => {
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

async function post(base, body) {
  const response = await fetch(`${base}/api/designs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const server = await listen(createApp({ collection: memoryCollection() }));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  assert(readLimit("99") === 50 && readLimit("0") === 1 && readLimit("nope") === 20, "limit clamp");

  const missing = await post(base, { params: defaultShape(), wind: { mode: "off" } });
  assert(missing.status === 400 && missing.body.ok === false, "empty name is rejected");

  const tagged = await post(base, {
    name: "  <b>Ada</b>  ",
    params: { ...defaultShape(), speed: 4, angleDeg: 3 },
    wind: { mode: "off" },
    distance: 99999,
  });
  const expected = simulate(
    derivePlane(clampShape(defaultShape())),
    { speed: 4, angleDeg: 3, height: LAUNCH_HEIGHT },
    { mode: "off" }
  ).distance;
  assert(tagged.status === 200 && tagged.body.ok === true, "tagged name is accepted");
  assert(Math.abs(tagged.body.distance - expected) < 1e-9, "server recomputes distance");
  assert(tagged.body.distance !== 99999, "client distance is ignored");

  const wide = { ...defaultShape(), span: 9, speed: 4, angleDeg: 3 };
  const wideExpected = simulate(
    derivePlane(clampShape(wide)),
    { speed: 4, angleDeg: 3, height: LAUNCH_HEIGHT },
    { mode: "off" }
  ).distance;
  const clamped = await post(base, { name: "Wide", params: wide, wind: { mode: "off" } });
  assert(Math.abs(clamped.body.distance - wideExpected) < 1e-9, "span is clamped before the flight");

  const longName = await post(base, {
    name: "12345678901234567890EXTRA",
    params: { ...defaultShape(), speed: 7, angleDeg: 4 },
    wind: { mode: "off" },
  });
  assert(longName.body.ok === true, "long name is accepted");

  const fast = await post(base, {
    name: "Bo",
    params: { ...defaultShape(), speed: 15, angleDeg: 8 },
    wind: { mode: "off" },
  });
  const again = await post(base, {
    name: "Cy",
    params: { ...defaultShape(), speed: 4, angleDeg: 3 },
    wind: { mode: "off" },
  });
  assert(again.body.distance === tagged.body.distance, "same throw recomputes the same distance");
  assert(again.body.rank > tagged.body.rank, "an earlier equal distance ranks ahead");

  const boardRes = await fetch(`${base}/api/leaderboard?limit=20`);
  const board = await boardRes.json();
  assert(board.ok === true, "leaderboard ok");
  const ada = board.entries.find((row) => row.name === "Ada");
  assert(ada && ada.wind === "off" && typeof ada.span === "number" && typeof ada.speed === "number", "public entry fields");
  assert(!("params" in ada) && !("endReason" in ada), "stored extras stay off the board");
  assert(board.entries.some((row) => row.name === "12345678901234567890"), "name is trimmed to 20 characters");
  assert(!JSON.stringify(board).includes("<b>"), "html is not stored");
  for (let i = 1; i < board.entries.length; i += 1) {
    const prev = board.entries[i - 1];
    const row = board.entries[i];
    const ordered = prev.distance > row.distance
      || (prev.distance === row.distance && new Date(prev.createdAt) <= new Date(row.createdAt));
    assert(ordered, "sorted by distance, then time");
  }
  const top = await (await fetch(`${base}/api/leaderboard?limit=1`)).json();
  assert(top.entries.length === 1 && top.entries[0].name === board.entries[0].name, "limit is applied");
  assert(fast.body.ok === true, "fast throw is stored from the server flight");
} finally {
  await new Promise((resolve) => server.close(resolve));
}

const savedUri = process.env.MONGODB_URI;
delete process.env.MONGODB_URI;
const offline = await listen(createApp({ offline: true }));
try {
  const down = await post(`http://127.0.0.1:${offline.address().port}`, {
    name: "Ada",
    params: defaultShape(),
    wind: { mode: "off" },
  });
  const list = await fetch(`http://127.0.0.1:${offline.address().port}/api/leaderboard`);
  const listBody = await list.json();
  assert(down.status === 503 && down.body.ok === false, "post returns 503 when the database is down");
  assert(list.status === 200 && listBody.ok === false && Array.isArray(listBody.entries) && listBody.entries.length === 0, "get falls back empty");
} finally {
  if (savedUri) process.env.MONGODB_URI = savedUri;
  await new Promise((resolve) => offline.close(resolve));
}

if (!process.exitCode) console.log("Leaderboard checks passed.");
