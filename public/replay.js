import { compareFlights, deleteFlight, flightTelemetry, getHealth, listFlights } from "./api.js";

const TOKEN_KEY = "clouds.adminToken";
const IDLE = "Replay a flight or compare two in the Flights tab";
const SPEEDS = [0.25, 0.5, 1, 2];
const INK = "#243027";
const BLUE = "#2c6cb0";
const ORANGE = "#d2652d";
const CURSOR = "#d2652d";
const STALL = "rgba(210, 101, 45, 0.18)";
const PAPER = "#fbf8f2";
const GRID = "rgba(36, 48, 39, 0.12)";
const MUTED = "#8d998f";

export function flightName(label, slot) {
  const text = String(label ?? "").trim();
  if (!text || /^\d+(?:\.\d+)?\s*m$/i.test(text)) return `Flight ${slot}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function meters(value) {
  const distance = Number(value);
  return Number.isFinite(distance) ? `${distance.toFixed(2)} m` : null;
}

export function compareText(compared, distances = {}) {
  const a = flightName(compared.labels?.a, "A");
  const b = flightName(compared.labels?.b, "B");
  const diff = Number(compared.comparison?.distanceDiff) || 0;
  const pair = [meters(distances.a), meters(distances.b)].every(Boolean)
    ? ` (${meters(distances.a)} vs ${meters(distances.b)})`
    : "";
  const farther = diff === 0
    ? `${a} and ${b} flew the same distance${pair}.`
    : `${diff > 0 ? a : b} flew ${Math.abs(diff).toFixed(2)} m farther${pair}.`;
  const stallA = compared.comparison?.firstStall?.a;
  const stallB = compared.comparison?.firstStall?.b;
  let stall = "Neither flight stalled.";
  if (stallA == null && stallB != null) stall = `${b} stalled at ${Number(stallB).toFixed(1)} s; ${a} did not stall.`;
  else if (stallB == null && stallA != null) stall = `${a} stalled at ${Number(stallA).toFixed(1)} s; ${b} did not stall.`;
  else if (stallA != null && stallB != null) {
    const first = Number(stallA) <= Number(stallB) ? a : b;
    stall = `${first} stalled first at ${Math.min(Number(stallA), Number(stallB)).toFixed(1)} s.`;
  }
  const peakA = Number(compared.comparison?.peakSpeed?.a) || 0;
  const peakB = Number(compared.comparison?.peakSpeed?.b) || 0;
  const peaks = `Peak speed: A ${peakA.toFixed(1)} m/s, B ${peakB.toFixed(1)} m/s.`;
  const diverge = compared.comparison?.divergeAt == null
    ? "Paths stayed within 0.5 m."
    : `Paths diverged at ${Number(compared.comparison.divergeAt).toFixed(2)} s.`;
  return `${farther} ${stall} ${peaks} ${diverge}`;
}

export function stallBands(times, stalled) {
  const bands = [];
  const axis = Array.isArray(times) ? times : [];
  const flags = Array.isArray(stalled) ? stalled : [];
  let start = null;
  let end = null;
  for (let index = 0; index < axis.length; index += 1) {
    const t = Number(axis[index]);
    if (flags[index] === true && Number.isFinite(t)) {
      if (start == null) start = t;
      end = t;
    } else if (start != null) {
      bands.push({ start, end });
      start = null;
      end = null;
    }
  }
  if (start != null) bands.push({ start, end });
  return bands;
}

export function plotX(t, t0, t1, left, width) {
  const span = (Number(t1) - Number(t0)) || 1;
  return left + ((Number(t) - Number(t0)) / span) * width;
}

function niceStep(span, parts) {
  const rough = span / Math.max(1, parts);
  if (!(rough > 0) || !Number.isFinite(rough)) return 1;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const res = rough / mag;
  const nice = res <= 1 ? 1 : res <= 2 ? 2 : res <= 5 ? 5 : 10;
  return nice * mag;
}

function tickList(min, max, gap) {
  const ticks = [];
  const first = Math.floor(min / gap + 1e-9) * gap;
  const last = Math.ceil(max / gap - 1e-9) * gap;
  for (let n = 0; n < 10; n += 1) {
    const value = Number((first + n * gap).toFixed(6));
    if (value > last + gap * 0.25) break;
    ticks.push(value);
  }
  return ticks;
}

function stepBeside(gap, direction) {
  const mag = 10 ** Math.floor(Math.log10(gap));
  const ladder = [1, 2, 5];
  let index = ladder.findIndex((item) => item >= gap / mag - 1e-9);
  if (index < 0) index = ladder.length - 1;
  index += direction;
  let next = mag;
  if (index > 2) {
    index = 0;
    next = mag * 10;
  } else if (index < 0) {
    index = 2;
    next = mag / 10;
  }
  return ladder[index] * next;
}

export function axisTicks(min, max) {
  if (!(max > min)) return [Number.isFinite(min) ? min : 0];
  let step = niceStep(max - min, 5);
  let ticks = tickList(min, max, step);
  while (ticks.length > 6 && step < (max - min) * 2) {
    step = stepBeside(step, 1);
    ticks = tickList(min, max, step);
  }
  while (ticks.length < 4 && step > (max - min) / 20) {
    step = stepBeside(step, -1);
    ticks = tickList(min, max, step);
  }
  return ticks.length ? ticks : [min, max];
}

function tickText(value, step) {
  const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return Number(value.toFixed(digits)).toString();
}

function seriesExtent(tracks) {
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const track of tracks) {
    for (const value of track.series?.t || []) {
      const t = Number(value);
      if (!Number.isFinite(t)) continue;
      if (t < t0) t0 = t;
      if (t > t1) t1 = t;
    }
  }
  if (!(t1 > t0)) return null;
  return { t0, t1 };
}

function rowsFrom(series) {
  const count = series?.t?.length || 0;
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    rows.push({
      t: Number(series.t[index]) || 0,
      x: Number(series.x[index]) || 0,
      y: Number(series.y[index]) || 0,
      theta: Number(series.theta[index]) || 0,
      vx: Number(series.vx[index]) || 0,
      vy: Number(series.vy[index]) || 0,
    });
  }
  return rows;
}

function fitCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.floor((rect.width || canvas.clientWidth || 240) * dpr));
  const height = Math.max(1, Math.floor((rect.height || 120) * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { width, height, dpr };
}

function drawChart(canvas, tracks, time, key, scale) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const { width, height, dpr } = fitCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, width, height);
  const extent = seriesExtent(tracks);
  if (!extent) return;
  const values = [];
  for (const track of tracks) {
    const column = track.series?.[key] || [];
    for (const value of column) {
      if (value == null) continue;
      const next = scale(value);
      if (Number.isFinite(next)) values.push(next);
    }
  }
  if (!values.length) return;
  const yTicks = axisTicks(Math.min(...values), Math.max(...values));
  const xTicks = axisTicks(extent.t0, extent.t1);
  const yLo = yTicks[0];
  const yHi = yTicks[yTicks.length - 1];
  const ySpan = yHi - yLo || 1;
  const plotLeft = 44 * dpr;
  const plotRight = width - 12 * dpr;
  const plotTop = 10 * dpr;
  const plotBottom = height - 24 * dpr;
  const plotWidth = Math.max(1, plotRight - plotLeft);
  const plotHeight = Math.max(1, plotBottom - plotTop);
  const xOf = (t) => plotX(t, extent.t0, extent.t1, plotLeft, plotWidth);
  const yOf = (value) => plotBottom - ((value - yLo) / ySpan) * plotHeight;
  const yStep = yTicks.length > 1 ? Math.abs(yTicks[1] - yTicks[0]) : 1;
  const xStep = xTicks.length > 1 ? Math.abs(xTicks[1] - xTicks[0]) : 1;

  ctx.strokeStyle = GRID;
  ctx.lineWidth = Math.max(1, dpr);
  ctx.beginPath();
  for (const tick of yTicks) {
    const y = yOf(tick);
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotRight, y);
  }
  for (const tick of xTicks) {
    const x = xOf(tick);
    ctx.moveTo(x, plotTop);
    ctx.lineTo(x, plotBottom);
  }
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.rect(plotLeft, plotTop, plotWidth, plotHeight);
  ctx.clip();
  for (const track of tracks) {
    const axis = track.series?.t || [];
    ctx.fillStyle = track.stall || STALL;
    for (const band of stallBands(axis, track.series?.stalled)) {
      const start = xOf(band.start);
      const end = Math.max(xOf(band.end), start + 2 * dpr);
      ctx.fillRect(start, plotTop, end - start, plotHeight);
    }
  }
  for (const track of tracks) {
    const column = track.series?.[key] || [];
    const axis = track.series?.t || [];
    ctx.beginPath();
    ctx.strokeStyle = track.color;
    ctx.lineWidth = Math.max(1.25, 1.4 * dpr);
    let moved = false;
    for (let index = 0; index < axis.length; index += 1) {
      if (column[index] == null) continue;
      const value = scale(column[index]);
      const t = Number(axis[index]);
      if (!Number.isFinite(value) || !Number.isFinite(t)) continue;
      const x = xOf(t);
      const y = yOf(value);
      if (!moved) {
        ctx.moveTo(x, y);
        moved = true;
      } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const cursor = xOf(Math.min(extent.t1, Math.max(extent.t0, Number(time) || 0)));
  ctx.strokeStyle = CURSOR;
  ctx.lineWidth = Math.max(1, dpr);
  ctx.beginPath();
  ctx.moveTo(cursor, plotTop);
  ctx.lineTo(cursor, plotBottom);
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = MUTED;
  ctx.font = `${11 * dpr}px Georgia, serif`;
  ctx.textAlign = "right";
  for (const tick of yTicks) {
    const y = yOf(tick);
    ctx.textBaseline = Math.abs(y - plotTop) < 1 ? "top" : Math.abs(y - plotBottom) < 1 ? "bottom" : "middle";
    ctx.fillText(tickText(tick, yStep), plotLeft - 6 * dpr, y);
  }
  ctx.textBaseline = "top";
  for (const tick of xTicks) {
    const x = xOf(tick);
    const atStart = Math.abs(x - plotLeft) < 1;
    const atEnd = Math.abs(x - plotRight) < 1;
    ctx.textAlign = atStart ? "left" : atEnd ? "right" : "center";
    ctx.fillText(tickText(tick, xStep), x, plotBottom + 4 * dpr);
  }
}

export function initReplay(view, hooks = {}) {
  const list = document.querySelector("#flight-list");
  const badge = document.querySelector("#telemetry-badge");
  const refreshButton = document.querySelector("#flights-refresh");
  const clearButton = document.querySelector("#flights-clear");
  const flightNote = document.querySelector("#flight-note");
  const playButton = document.querySelector("#replay-play");
  const scrubber = document.querySelector("#replay-scrub");
  const charts = document.querySelector("#replay-charts");
  const telemetryStatus = document.querySelector("#telemetry-status");
  const compareButton = document.querySelector("#compare-go");
  const compareCard = document.querySelector("#compare-card");
  const coachButton = document.querySelector("#compare-coach");
  const legend = document.querySelector("#compare-legend");
  const altitude = document.querySelector("#chart-altitude");
  const speedChart = document.querySelector("#chart-speed");
  const alphaChart = document.querySelector("#chart-alpha");
  if (!list || !view) return { stop() {}, refresh() {}, redraw() {} };

  let flights = [];
  const picked = [];
  let loadedIds = [];
  let series = null;
  let tracks = [];
  let rows = [];
  let ghost = null;
  let time = 0;
  let duration = 0.01;
  let speed = 1;
  let coachOn = false;
  let latest = null;
  let playing = false;
  let raf = 0;
  let last = 0;

  function paint(at) {
    const panel = document.querySelector("#tab-telemetry");
    if (panel?.hidden) return;
    drawChart(altitude, tracks, at, "y", (value) => Number(value));
    drawChart(speedChart, tracks, at, "speed", (value) => Number(value));
    drawChart(alphaChart, tracks, at, "alpha", (value) => (Number(value) * 180) / Math.PI);
  }

  function openTelemetry() {
    hooks.showTab?.("telemetry");
  }

  function showTelemetry(text, chartsOn) {
    if (telemetryStatus) telemetryStatus.textContent = text;
    if (charts) charts.hidden = !chartsOn;
  }

  function note(text) {
    if (!flightNote) return;
    flightNote.hidden = !text;
    flightNote.textContent = text || "";
  }

  function resetPlayback() {
    halt();
    series = null;
    tracks = [];
    rows = [];
    ghost = null;
    loadedIds = [];
    time = 0;
    clearCompare();
    showTelemetry(IDLE, false);
    syncPlay();
    syncScrub();
    hooks.resetView?.();
  }

  function adminToken() {
    let token = "";
    try {
      token = sessionStorage.getItem(TOKEN_KEY) || "";
    } catch {
      token = "";
    }
    if (token) return token;
    const entered = window.prompt("Admin token");
    if (!entered || !entered.trim()) return "";
    token = entered.trim();
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* a private window can still delete this once */
    }
    return token;
  }

  async function removeOne(id, token) {
    const status = await deleteFlight(id, token);
    if (status === 403) {
      try {
        sessionStorage.removeItem(TOKEN_KEY);
      } catch {
        /* ignore */
      }
      note("Wrong admin token");
      return false;
    }
    if (status !== 200) {
      note("Could not delete that flight");
      return false;
    }
    return true;
  }

  function distanceOf(id) {
    const flight = flights.find((item) => item.flight_id === id);
    return Number(flight?.distance);
  }

  function syncCoach() {
    if (coachButton) coachButton.hidden = !(coachOn && latest);
  }

  function clearCompare() {
    ghost = null;
    latest = null;
    syncCoach();
    if (compareCard) {
      compareCard.hidden = true;
      compareCard.textContent = "";
    }
    if (legend) {
      legend.hidden = true;
      legend.replaceChildren();
    }
  }

  function syncScrub() {
    if (!scrubber) return;
    scrubber.value = String(Math.round((time / duration) * 1000));
  }

  function syncPlay() {
    if (!playButton) return;
    playButton.disabled = !series;
    playButton.textContent = playing ? "Pause" : "Play";
    if (scrubber) scrubber.disabled = !series;
  }

  function syncCompare() {
    if (compareButton) compareButton.disabled = picked.length !== 2;
  }

  function halt() {
    playing = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    syncPlay();
  }

  function tick(now) {
    if (!playing) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    time = Math.min(duration, time + dt * speed);
    view.seek(time);
    paint(time);
    syncScrub();
    if (time >= duration) {
      halt();
      return;
    }
    raf = requestAnimationFrame(tick);
  }

  function playFrom(start) {
    time = start;
    last = performance.now();
    playing = true;
    syncPlay();
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }

  function showAt(next) {
    time = Math.min(duration, Math.max(0, next));
    view.seek(time);
    paint(time);
    syncScrub();
  }

  async function replay(flight) {
    const loaded = await flightTelemetry(flight.flight_id, 0.05);
    if (!loaded?.t?.length) return;
    clearCompare();
    loadedIds = [flight.flight_id];
    series = loaded;
    tracks = [{ series, color: INK }];
    rows = rowsFrom(loaded);
    duration = Math.max(Number(loaded.t[loaded.t.length - 1]) || 0, 0.01);
    showTelemetry(`Replaying ${flightName(flight.label, "A")}`, true);
    syncPlay();
    openTelemetry();
    view.showSamples(rows, 0, { duration, distance: Number(flight.distance) || 0, ghost });
    paint(0);
    requestAnimationFrame(() => paint(time));
    syncScrub();
    playFrom(0);
  }

  function renderList() {
    if (clearButton) clearButton.disabled = !flights.length;
    list.replaceChildren();
    if (!flights.length) {
      const empty = document.createElement("li");
      empty.textContent = "No flights yet.";
      list.append(empty);
      return;
    }
    for (const flight of flights) {
      const row = document.createElement("li");
      row.className = "flight-row";
      const text = document.createElement("span");
      const distance = Number(flight.distance);
      const flightTime = Number(flight.flight_time);
      text.textContent = `${flight.label || "flight"} · ${Number.isFinite(distance) ? distance.toFixed(2) : "—"} m · ${Number.isFinite(flightTime) ? flightTime.toFixed(2) : "—"} s · ${flight.end_reason || "—"}`;
      const replayButton = document.createElement("button");
      replayButton.type = "button";
      replayButton.className = "quiet";
      replayButton.textContent = "Replay";
      replayButton.addEventListener("click", () => replay(flight));
      const compare = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = picked.includes(flight.flight_id);
      box.addEventListener("change", () => {
        const id = flight.flight_id;
        const index = picked.indexOf(id);
        if (box.checked && index < 0) {
          if (picked.length >= 2) picked.shift();
          picked.push(id);
        } else if (!box.checked && index >= 0) picked.splice(index, 1);
        syncCompare();
        renderList();
      });
      compare.append(box, document.createTextNode(" Compare"));
      const trash = document.createElement("button");
      trash.type = "button";
      trash.className = "quiet icon-button";
      trash.setAttribute("aria-label", `Delete ${flight.label || "flight"}`);
      trash.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 4h10M6 4V3h4v1M5 4l1 9h4l1-9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
      trash.addEventListener("click", () => discard(flight));
      row.append(text, replayButton, compare, trash);
      list.append(row);
    }
    syncCompare();
  }

  async function refresh() {
    const [health, body] = await Promise.all([getHealth(), listFlights(20)]);
    coachOn = health?.coach === true;
    syncCoach();
    if (badge) badge.hidden = health?.telemetry?.mode !== "local";
    flights = Array.isArray(body?.flights) ? body.flights : [];
    renderList();
  }

  compareButton?.addEventListener("click", async () => {
    if (picked.length !== 2) return;
    const compared = await compareFlights(picked[0], picked[1], 0.05);
    if (!compared?.a?.t?.length || !compared?.b?.t?.length) return;
    loadedIds = [picked[0], picked[1]];
    series = compared.a;
    tracks = [
      { series: compared.a, color: BLUE, stall: "rgba(44, 108, 176, 0.2)" },
      { series: compared.b, color: ORANGE, stall: "rgba(210, 101, 45, 0.2)" },
    ];
    rows = rowsFrom(compared.a);
    ghost = rowsFrom(compared.b);
    const endA = Number(compared.a.t[compared.a.t.length - 1]) || 0;
    const endB = Number(compared.b.t[compared.b.t.length - 1]) || 0;
    duration = Math.max(endA, endB, 0.01);
    const nameA = flightName(compared.labels?.a, "A");
    const nameB = flightName(compared.labels?.b, "B");
    showTelemetry(`Comparing ${nameA} vs ${nameB}`, true);
    syncPlay();
    openTelemetry();
    latest = compared;
    syncCoach();
    if (compareCard) {
      compareCard.hidden = false;
      compareCard.textContent = compareText(compared, {
        a: distanceOf(picked[0]),
        b: distanceOf(picked[1]),
      });
    }
    if (legend) {
      legend.hidden = false;
      legend.replaceChildren();
      const a = document.createElement("span");
      a.className = "compare-a";
      a.textContent = nameA;
      const b = document.createElement("span");
      b.className = "compare-b";
      b.textContent = nameB;
      legend.append(a, b);
    }
    view.showSamples(rows, 0, { duration, ghost });
    paint(0);
    requestAnimationFrame(() => paint(time));
    syncScrub();
    playFrom(0);
  });
  coachButton?.addEventListener("click", () => {
    if (!latest || !coachOn) return;
    hooks.askCompare?.({ comparison: latest.comparison, params: latest.params });
  });
  async function discard(flight) {
    const label = flight.label || "flight";
    if (!window.confirm(`Delete '${label}'?`)) return;
    const token = adminToken();
    if (!token) return;
    if (!(await removeOne(flight.flight_id, token))) return;
    note("");
    const index = picked.indexOf(flight.flight_id);
    if (index >= 0) picked.splice(index, 1);
    if (loadedIds.includes(flight.flight_id)) resetPlayback();
    await refresh();
  }

  refreshButton?.addEventListener("click", () => refresh());
  clearButton?.addEventListener("click", async () => {
    if (!flights.length) return;
    if (!window.confirm(`Delete all ${flights.length} flights?`)) return;
    const token = adminToken();
    if (!token) return;
    for (const flight of flights.slice()) {
      if (!(await removeOne(flight.flight_id, token))) return;
    }
    note("");
    picked.splice(0, picked.length);
    resetPlayback();
    await refresh();
  });
  playButton?.addEventListener("click", () => {
    if (!series) return;
    if (playing) {
      halt();
      return;
    }
    playFrom(time >= duration ? 0 : time);
  });
  scrubber?.addEventListener("input", () => {
    if (!series) return;
    showAt((Number(scrubber.value) / 1000) * duration);
    last = performance.now();
  });
  document.querySelectorAll("#replay-speeds [data-speed]").forEach((button) => {
    button.addEventListener("click", () => {
      speed = SPEEDS.includes(Number(button.dataset.speed)) ? Number(button.dataset.speed) : 1;
      document.querySelectorAll("#replay-speeds [data-speed]").forEach((item) => {
        item.setAttribute("aria-pressed", String(item === button));
      });
    });
  });
  window.addEventListener("resize", () => {
    if (series) paint(time);
  });
  const telemetryPanel = document.querySelector("#tab-telemetry");
  if (telemetryPanel && typeof ResizeObserver === "function") {
    let seenWidth = 0;
    new ResizeObserver(() => {
      const width = telemetryPanel.clientWidth;
      if (!series || telemetryPanel.hidden || !width || width === seenWidth) return;
      seenWidth = width;
      paint(time);
    }).observe(telemetryPanel);
  }

  syncPlay();
  syncCompare();
  refresh();
  return {
    stop() {
      halt();
    },
    refresh,
    picked: () => picked.slice(),
    redraw() {
      if (series) paint(time);
    },
  };
}
