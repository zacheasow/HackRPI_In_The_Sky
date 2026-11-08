import { leaderboard, readLocalBoard } from "./api.js";
import { bindSoftLeaderboardNav, startIdleAudio, unlockAudioOnGesture } from "./audio.js";
import { bootHome } from "./landing.js";

let showAll = false;
let entries = [];
let els = null;

function when(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function bestOnly(list) {
  const best = new Map();
  for (const entry of list) {
    const key = String(entry.name || "").trim().toLowerCase();
    const prev = best.get(key);
    if (!prev || Number(entry.distance) > Number(prev.distance)) best.set(key, entry);
  }
  return [...best.values()].sort((a, b) => Number(b.distance) - Number(a.distance));
}

function cell(text, className) {
  const td = document.createElement("td");
  if (className) td.className = className;
  td.textContent = text;
  return td;
}

function render() {
  if (!els) return;
  const { rows, empty, table } = els;
  const list = (showAll ? entries.slice() : bestOnly(entries)).slice(0, 50);
  rows.replaceChildren(...list.map((entry, index) => {
    const row = document.createElement("tr");
    const rank = document.createElement("td");
    if (index < 3) {
      const badge = document.createElement("span");
      badge.className = `rank rank-${index + 1}`;
      badge.textContent = String(index + 1);
      rank.append(badge);
    } else {
      rank.textContent = String(index + 1);
    }
    const speed = Number(entry.speed);
    const angle = Number(entry.angle);
    const span = Number(entry.span);
    const distance = Number(entry.distance);
    const throwText = Number.isFinite(speed) && Number.isFinite(angle)
      ? `${speed.toFixed(1)} m/s, ${angle.toFixed(0)}°`
      : "—";
    row.append(
      rank,
      cell(entry.name || "—"),
      cell(Number.isFinite(distance) ? `${distance.toFixed(2)} m` : "—", "board-distance"),
      cell(Number.isFinite(span) ? `${Math.round(span * 100)} cm` : "—"),
      cell(throwText),
      cell(entry.wind === "off" ? "Off" : entry.wind ? "On" : "—"),
      cell(when(entry.createdAt) || "—"),
    );
    return row;
  }));
  const none = list.length === 0;
  empty.hidden = !none;
  if (table) table.hidden = none;
}

async function load() {
  if (!els) return;
  els.note.textContent = "This browser only";
  entries = readLocalBoard();
  render();
  const remote = await leaderboard(50);
  if (remote?.ok && remote.entries.length > 0) {
    els.note.textContent = "The farthest throws.";
    entries = remote.entries;
    render();
  }
}

// Called on a normal page load and again after audio.js soft-loads this page.
export function bootLeaderboard() {
  const rows = document.querySelector("#board-rows");
  const note = document.querySelector("#board-note");
  const empty = document.querySelector("#board-empty");
  const refresh = document.querySelector("#board-refresh");
  const allButton = document.querySelector("#board-all");
  const table = document.querySelector(".board-table");
  if (!rows || !note || !empty || !refresh) return;
  els = { rows, note, empty, table };
  showAll = false;

  startIdleAudio();
  unlockAudioOnGesture();
  bindSoftLeaderboardNav();
  try {
    bootHome({ planeVisible: false });
  } catch {
    /* no sky canvas on this page */
  }

  refresh.onclick = () => load();
  if (allButton) {
    allButton.setAttribute("aria-pressed", "false");
    allButton.onclick = () => {
      showAll = !showAll;
      allButton.setAttribute("aria-pressed", showAll ? "true" : "false");
      render();
    };
  }
  void load();
}

if (document.body.classList.contains("board")) {
  bootLeaderboard();
}