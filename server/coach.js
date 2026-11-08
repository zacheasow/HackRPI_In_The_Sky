import { GoogleGenAI, Type } from "@google/genai";
import { CONFIG } from "../public/physics.js";
import { SHAPE_LIMITS } from "../public/plane.js";

export const COACH_PARAMS = ["span", "rootChord", "tipChord", "sweepDeg", "tailArea", "noseWeight"];
const TIMEOUT_MS = 10000;

const PARAM_KEYS = [...COACH_PARAMS, "speed", "angleDeg"];
const DERIVED_KEYS = ["wingArea", "aspectRatio", "mass", "cg", "ac", "staticMargin", "meanChord", "tailArm"];
const RESULT_KEYS = ["distance", "flightTime", "maxHeight", "endReason", "stalled", "stallTime", "blownBack", "peakSpeed"];
const WIND_KEYS = ["mode", "seed", "fixedSpeed", "steady", "gustMax", "avg"];
const DIAGNOSIS_KEYS = ["headline", "details", "tags"];
const FLIGHT_KEYS = ["params", "derived", "result", "wind", "diagnosis"];
const TOP_KEYS = [...FLIGHT_KEYS, "comparison"];
const END_REASONS = ["ground", "blown back", "timeout", "nan", "out-of-bounds"];
const WIND_MODES = ["random", "fixed", "off"];

const REQUIRED_DERIVED = ["wingArea", "aspectRatio", "mass", "cg", "ac", "staticMargin"];
const REQUIRED_RESULT = ["distance", "flightTime", "maxHeight", "endReason", "stalled"];

const SYSTEM = [
  "You are a friendly physics coach for a paper airplane simulator.",
  "Give 2-3 sentences explaining physically why this flight went the way it did (CG vs AC margin, aspect ratio, stall, wind), then 2-3 concrete numeric changes.",
  "Never invent numbers that aren't in the input.",
  "If a comparison is present, explain why flight A beat flight B (shape differences, stall timing, peak speed, where the paths diverged), and suggest changes to the losing design.",
  "Each suggestion change is a delta added to the current params.",
].join(" ");

function bad() {
  return { error: "bad" };
}

function onlyKeys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).every((key) => allowed.includes(key));
}

function readNumber(value, [min, max]) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function readText(value, max) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/<[^>]*>/g, "").replace(/[<>]/g, "").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, max);
}

function readParams(value) {
  if (!onlyKeys(value, PARAM_KEYS)) return null;
  const params = {};
  for (const key of COACH_PARAMS) {
    if (!(key in value)) return null;
    const next = readNumber(value[key], SHAPE_LIMITS[key]);
    if (next == null) return null;
    params[key] = next;
  }
  if (!("speed" in value) || !("angleDeg" in value)) return null;
  const speed = readNumber(value.speed, CONFIG.limits.speed);
  const angleDeg = readNumber(value.angleDeg, CONFIG.limits.angleDeg);
  if (speed == null || angleDeg == null) return null;
  params.speed = speed;
  params.angleDeg = angleDeg;
  return params;
}

function readDerived(value) {
  if (!onlyKeys(value, DERIVED_KEYS)) return null;
  const ranges = {
    wingArea: CONFIG.limits.wingArea,
    aspectRatio: CONFIG.limits.aspectRatio,
    mass: CONFIG.limits.mass,
    cg: CONFIG.limits.cg,
    ac: CONFIG.limits.ac,
    staticMargin: [-1, 2],
    meanChord: CONFIG.limits.meanChord,
    tailArm: CONFIG.limits.tailArm,
  };
  const derived = {};
  for (const key of REQUIRED_DERIVED) {
    if (!(key in value)) return null;
  }
  for (const key of DERIVED_KEYS) {
    if (!(key in value)) continue;
    const next = readNumber(value[key], ranges[key]);
    if (next == null) return null;
    derived[key] = next;
  }
  return derived;
}

function readResult(value) {
  if (!onlyKeys(value, RESULT_KEYS)) return null;
  for (const key of REQUIRED_RESULT) {
    if (!(key in value)) return null;
  }
  const distance = readNumber(value.distance, [0, CONFIG.maxRange]);
  const flightTime = readNumber(value.flightTime, [0, CONFIG.maxFlightTime]);
  const maxHeight = readNumber(value.maxHeight, [0, CONFIG.maxAltitude]);
  if (distance == null || flightTime == null || maxHeight == null) return null;
  if (typeof value.stalled !== "boolean") return null;
  if (typeof value.endReason !== "string" || !END_REASONS.includes(value.endReason)) return null;
  const result = {
    distance,
    flightTime,
    maxHeight,
    endReason: value.endReason,
    stalled: value.stalled,
  };
  if ("stallTime" in value) {
    if (value.stallTime === null) result.stallTime = null;
    else {
      const stallTime = readNumber(value.stallTime, [0, CONFIG.maxFlightTime]);
      if (stallTime == null) return null;
      result.stallTime = stallTime;
    }
  }
  if ("blownBack" in value) {
    if (typeof value.blownBack !== "boolean") return null;
    result.blownBack = value.blownBack;
  }
  if ("peakSpeed" in value) {
    const peakSpeed = readNumber(value.peakSpeed, [0, 40]);
    if (peakSpeed == null) return null;
    result.peakSpeed = peakSpeed;
  }
  return result;
}

function readWind(value) {
  if (!onlyKeys(value, WIND_KEYS)) return null;
  if (typeof value.mode !== "string" || !WIND_MODES.includes(value.mode)) return null;
  const wind = { mode: value.mode };
  if ("seed" in value) {
    const seed = readNumber(value.seed, [0, 4294967295]);
    if (seed == null) return null;
    wind.seed = Math.floor(seed);
  }
  for (const key of ["fixedSpeed", "steady", "gustMax", "avg"]) {
    if (!(key in value)) continue;
    const span = key === "gustMax" || key === "avg" ? [-8, 8] : [CONFIG.wind.steadyMin, CONFIG.wind.steadyMax];
    const next = readNumber(value[key], span);
    if (next == null) return null;
    wind[key] = next;
  }
  return wind;
}

function readDiagnosis(value) {
  if (!onlyKeys(value, DIAGNOSIS_KEYS)) return null;
  const headline = readText(value.headline, 400);
  if (!headline) return null;
  const diagnosis = { headline };
  if ("details" in value) {
    if (!Array.isArray(value.details) || value.details.length > 3) return null;
    const details = [];
    for (const item of value.details) {
      const text = readText(item, 240);
      if (!text) return null;
      details.push(text);
    }
    diagnosis.details = details;
  }
  if ("tags" in value) {
    if (!Array.isArray(value.tags) || value.tags.length > 6) return null;
    const tags = [];
    for (const item of value.tags) {
      const text = readText(item, 40);
      if (!text) return null;
      tags.push(text);
    }
    diagnosis.tags = tags;
  }
  return diagnosis;
}

function readFlight(value) {
  if (!onlyKeys(value, FLIGHT_KEYS)) return null;
  for (const key of FLIGHT_KEYS) {
    if (!(key in value)) return null;
  }
  const params = readParams(value.params);
  const derived = readDerived(value.derived);
  const result = readResult(value.result);
  const wind = readWind(value.wind);
  const diagnosis = readDiagnosis(value.diagnosis);
  if (!params || !derived || !result || !wind || !diagnosis) return null;
  return { params, derived, result, wind, diagnosis };
}

function readOptionalTime(value) {
  if (value == null) return null;
  return readNumber(value, [0, CONFIG.maxFlightTime]);
}

function readCompareStats(value) {
  if (!onlyKeys(value, ["distanceDiff", "timeDiff", "maxHeightDiff", "firstStall", "peakSpeed", "divergeAt"])) return null;
  const distanceDiff = readNumber(value.distanceDiff, [-CONFIG.maxRange, CONFIG.maxRange]);
  const timeDiff = readNumber(value.timeDiff, [-CONFIG.maxFlightTime, CONFIG.maxFlightTime]);
  const maxHeightDiff = readNumber(value.maxHeightDiff, [-CONFIG.maxAltitude, CONFIG.maxAltitude]);
  const stall = value.firstStall;
  const peak = value.peakSpeed;
  if (distanceDiff == null || timeDiff == null || maxHeightDiff == null || !stall || !peak) return null;
  if (!onlyKeys(stall, ["a", "b"]) || !onlyKeys(peak, ["a", "b"])) return null;
  const stallA = readOptionalTime(stall.a);
  const stallB = readOptionalTime(stall.b);
  if ((stall.a != null && stallA == null) || (stall.b != null && stallB == null)) return null;
  const peakA = readNumber(peak.a, [0, 80]);
  const peakB = readNumber(peak.b, [0, 80]);
  if (peakA == null || peakB == null) return null;
  const divergeAt = readOptionalTime(value.divergeAt);
  if (value.divergeAt != null && divergeAt == null) return null;
  return {
    distanceDiff,
    timeDiff,
    maxHeightDiff,
    firstStall: { a: stallA, b: stallB },
    peakSpeed: { a: peakA, b: peakB },
    divergeAt,
  };
}

export function prepareCoach(body) {
  if (body && body.params && body.params.a && body.params.b && body.comparison && !("result" in body)) {
    if (!onlyKeys(body, ["params", "comparison"]) || !onlyKeys(body.params, ["a", "b"])) return bad();
    const a = readParams(body.params.a);
    const b = readParams(body.params.b);
    const comparison = readCompareStats(body.comparison);
    if (!a || !b || !comparison) return bad();
    return { brief: { params: { a, b }, comparison }, suggestFor: comparison.distanceDiff >= 0 ? b : a };
  }
  if (!onlyKeys(body, TOP_KEYS)) return bad();
  for (const key of FLIGHT_KEYS) {
    if (!(key in body)) return bad();
  }
  const { comparison, ...rest } = body;
  const flight = readFlight(rest);
  if (!flight) return bad();
  if (!("comparison" in body) || comparison == null) return { brief: flight };
  if (!onlyKeys(comparison, ["a", "b"])) return bad();
  if (!("a" in comparison) || !("b" in comparison)) return bad();
  const a = readFlight(comparison.a);
  const b = readFlight(comparison.b);
  if (!a || !b) return bad();
  return { brief: { ...flight, comparison: { a, b } } };
}

export function clampCoachOutput(raw, params) {
  const explanation = readText(raw?.explanation, 800);
  if (!explanation || !Array.isArray(raw.suggestions)) return null;
  const suggestions = [];
  for (const item of raw.suggestions) {
    if (suggestions.length >= 3) break;
    if (!item || typeof item !== "object") continue;
    if (!COACH_PARAMS.includes(item.parameter)) continue;
    if (typeof item.change !== "number" || !Number.isFinite(item.change)) continue;
    const reason = readText(item.reason, 200);
    if (!reason) continue;
    const [min, max] = SHAPE_LIMITS[item.parameter];
    const current = params[item.parameter];
    const next = Math.min(max, Math.max(min, current + item.change));
    const change = Math.round((next - current) * 1e6) / 1e6;
    suggestions.push({ parameter: item.parameter, change, reason });
  }
  return { explanation, suggestions };
}

function responseSchema() {
  return {
    type: Type.OBJECT,
    properties: {
      explanation: { type: Type.STRING },
      suggestions: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            parameter: { type: Type.STRING, enum: COACH_PARAMS },
            change: { type: Type.NUMBER },
            reason: { type: Type.STRING },
          },
          required: ["parameter", "change", "reason"],
        },
      },
    },
    required: ["explanation", "suggestions"],
  };
}

async function callGemini(brief) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    contents: JSON.stringify(brief),
    config: {
      systemInstruction: SYSTEM,
      responseMimeType: "application/json",
      responseSchema: responseSchema(),
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    },
  });
  return JSON.parse(response.text || "");
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function askCoach(body, client) {
  const prepared = prepareCoach(body);
  if (prepared.error) return prepared;
  if (!client && !process.env.GEMINI_API_KEY) return { unavailable: true };
  try {
    const raw = client ? await withTimeout(client(prepared.brief), TIMEOUT_MS) : await callGemini(prepared.brief);
    const output = clampCoachOutput(raw, prepared.suggestFor || prepared.brief.params);
    if (!output) return { unavailable: true };
    return { ok: true, ...output };
  } catch {
    console.error("Coach unavailable");
    return { unavailable: true };
  }
}
