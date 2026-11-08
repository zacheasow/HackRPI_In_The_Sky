import { leaderboard, readLocalBoard } from "./api.js";
import { bindSoftLeaderboardNav, startIdleAudio, unlockAudioOnGesture } from "./audio.js";

function when(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function render(entries, rows, empty) {
  rows.replaceChildren(...entries.slice(0, 50).map((entry, index) => {
    const row = document.createElement("tr");
    if (index < 3) row.className = "top";
    const cells = [
      String(index + 1),
      entry.name,
      `${Number(entry.distance).toFixed(2)} m`,
      entry.wind === "off" ? "Off" : "On",
      when(entry.createdAt),
    ];
    for (const text of cells) {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.append(cell);
    }
    return row;
  }));
  const none = entries.length === 0;
  empty.hidden = !none;
  rows.parentElement.hidden = none;
}

async function load(rows, empty, note) {
  note.textContent = "This browser only";
  render(readLocalBoard(), rows, empty);
  const remote = await leaderboard(20);
  if (remote?.ok && remote.entries.length > 0) {
    note.textContent = "The farthest throws.";
    render(remote.entries, rows, empty);
  }
}

export function bootLeaderboard() {
  const rows = document.querySelector("#board-rows");
  const note = document.querySelector("#board-note");
  const empty = document.querySelector("#board-empty");
  const refresh = document.querySelector("#board-refresh");
  if (!rows || !note || !empty || !refresh) return;

  startIdleAudio();
  unlockAudioOnGesture();
  bindSoftLeaderboardNav();

  refresh.onclick = () => load(rows, empty, note);
  void load(rows, empty, note);
}

if (document.body.classList.contains("board")) {
  bootLeaderboard();
}
