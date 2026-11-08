import { compareFlights, flightTelemetry, getHealth, listFlights } from "./api.js";

const SPEEDS = [0.25, 0.5, 1, 2];
const INK = "#243027";
const BLUE = "#2c6cb0";
const ORANGE = "#d2652d";
const CURSOR = "#d2652d";
const STALL = "rgba(210, 101, 45, 0.18)";
const PAPER = "#fbf8f2";

function titled(label, fallback) {
  const text = String(label || fallback);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function compareText(compared) {
  const a = titled(compared.labels?.a, "A");
  const b = titled(compared.labels?.b, "B");
  const diff = Number(compared.comparison?.distanceDiff) || 0;
  const farther = diff === 0
    ? `${a} and ${b} flew the same distance.`
    : `${diff > 0 ? a : b} flew ${Math.abs(diff).toFixed(2)} m farther.`;
  const stallA = compared.comparison?.firstStall?.a;
  const stallB = compared.comparison?.firstStall?.b;
  let stall = "Neither flight stalled.";
  if (stallA == null && stallB != null) stall = `${b} stalled at ${Number(stallB).toFixed(1)} s. ${a} did not stall.`;
  else if (stallB == null && stallA != null) stall = `${a} stalled at ${Number(stallA).toFixed(1)} s. ${b} did not stall.`;
  else if (stallA != null && stallB != null) {
    const first = Number(stallA) <= Number(stallB) ? a : b;
    stall = `${first} stalled first at ${Math.min(Number(stallA), Number(stallB)).toFixed(1)} s.`;
  }
  const peakA = Number(compared.comparison?.peakSpeed?.a) || 0;
  const peakB = Number(compared.comparison?.peakSpeed?.b) || 0;
  const peaks = `Peak speed was ${peakA.toFixed(1)} m/s for ${a} and ${peakB.toFixed(1)} m/s for ${b}.`;
  const diverge = compared.comparison?.divergeAt == null
    ? "The paths stayed within 0.5 m."
    : `The paths diverged at ${Number(compared.comparison.divergeAt).toFixed(2)} s.`;
  return `${farther} ${stall} ${peaks} ${diverge}`;
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

function drawChart(canvas, tracks, time, key, label, scale) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const { width, height, dpr } = fitCanvas(canvas);
  const pad = 12 * dpr;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, width, height);
  const first = tracks[0]?.series;
  const times = first?.t || [];
  if (!times.length) return;
  const t0 = Number(times[0]) || 0;
  const t1 = Number(times[times.length - 1]) || t0 + 0.01;
  const values = [];
  for (const track of tracks) {
    const column = track.series?.[key] || [];
    for (const value of column) {
      const next = scale(value);
      if (Number.isFinite(next)) values.push(next);
    }
  }
  const min = Math.min(0, ...values);
  const max = Math.max(1, ...values);
  const span = max - min || 1;
  const xOf = (t) => pad + ((t - t0) / (t1 - t0 || 1)) * (width - pad * 2);
  const yOf = (value) => height - pad - ((value - min) / span) * (height - pad * 2);

  for (const track of tracks) {
    const axis = track.series?.t || [];
    const stalled = track.series?.stalled || [];
    ctx.fillStyle = track.stall || STALL;
    let band = null;
    for (let index = 0; index < axis.length; index += 1) {
      const on = stalled[index] === true;
      if (on && band == null) band = Number(axis[index]) || 0;
      if (!on && band != null) {
        const start = xOf(band);
        ctx.fillRect(start, pad, xOf(Number(axis[index]) || 0) - start, height - pad * 2);
        band = null;
      }
    }
    if (band != null) {
      const start = xOf(band);
      ctx.fillRect(start, pad, xOf(t1) - start, height - pad * 2);
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
      const value = scale(column[index]);
      if (!Number.isFinite(value)) continue;
      const x = xOf(Number(axis[index]) || 0);
      const y = yOf(value);
      if (!moved) {
        ctx.moveTo(x, y);
        moved = true;
      } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  const cursor = xOf(Math.min(t1, Math.max(t0, time)));
  ctx.strokeStyle = CURSOR;
  ctx.lineWidth = Math.max(1, dpr);
  ctx.beginPath();
  ctx.moveTo(cursor, pad);
  ctx.lineTo(cursor, height - pad);
  ctx.stroke();
  ctx.fillStyle = "#5c6b60";
  ctx.font = `${12 * dpr}px Georgia, serif`;
  ctx.fillText(label, pad, pad + 12 * dpr);
}

export function initReplay(view, hooks = {}) {
  const list = document.querySelector("#flight-list");
  const badge = document.querySelector("#telemetry-badge");
  const refreshButton = document.querySelector("#flights-refresh");
  const controls = document.querySelector("#replay-controls");
  const playButton = document.querySelector("#replay-play");
  const scrubber = document.querySelector("#replay-scrub");
  const charts = document.querySelector("#replay-charts");
  const compareButton = document.querySelector("#compare-go");
  const compareCard = document.querySelector("#compare-card");
  const coachButton = document.querySelector("#compare-coach");
  const legend = document.querySelector("#compare-legend");
  const altitude = document.querySelector("#chart-altitude");
  const speedChart = document.querySelector("#chart-speed");
  const alphaChart = document.querySelector("#chart-alpha");
  if (!list || !view) return { stop() {}, refresh() {} };

  let flights = [];
  const picked = [];
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
    drawChart(altitude, tracks, at, "y", "Altitude (m)", (value) => Number(value));
    drawChart(speedChart, tracks, at, "speed", "Speed (m/s)", (value) => Number(value));
    drawChart(alphaChart, tracks, at, "alpha", "Angle of attack (°)", (value) => (Number(value) * 180) / Math.PI);
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
    if (playButton) playButton.textContent = playing ? "Pause" : "Play";
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
    series = loaded;
    tracks = [{ series, color: INK }];
    rows = rowsFrom(loaded);
    duration = Math.max(Number(loaded.t[loaded.t.length - 1]) || 0, 0.01);
    if (charts) charts.hidden = false;
    if (controls) controls.hidden = false;
    view.showSamples(rows, 0, { duration, distance: Number(flight.distance) || 0, ghost });
    paint(0);
    requestAnimationFrame(() => paint(time));
    syncScrub();
    playFrom(0);
  }

  function renderList() {
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
        if (compareButton) compareButton.hidden = picked.length !== 2;
        renderList();
      });
      compare.append(box, document.createTextNode(" Compare"));
      row.append(text, replayButton, compare);
      list.append(row);
    }
    if (compareButton) compareButton.hidden = picked.length !== 2;
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
    if (charts) charts.hidden = false;
    if (controls) controls.hidden = false;
    latest = compared;
    syncCoach();
    if (compareCard) {
      compareCard.hidden = false;
      compareCard.textContent = compareText(compared);
    }
    if (legend) {
      legend.hidden = false;
      legend.replaceChildren();
      const a = document.createElement("span");
      a.className = "compare-a";
      a.textContent = `A ${titled(compared.labels?.a, "A")}`;
      const b = document.createElement("span");
      b.className = "compare-b";
      b.textContent = `B ${titled(compared.labels?.b, "B")}`;
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
  refreshButton?.addEventListener("click", () => refresh());
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

  refresh();
  return {
    stop() {
      halt();
    },
    refresh,
    picked: () => picked.slice(),
  };
}
