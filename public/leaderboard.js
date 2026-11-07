import { leaderboard, readLocalBoard } from "./api.js";

const rows = document.querySelector("#board-rows");
const note = document.querySelector("#board-note");
const empty = document.querySelector("#board-empty");

function when(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function render(entries) {
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

async function load() {
  const remote = await leaderboard(20);
  if (remote?.ok && remote.entries.length > 0) {
    note.textContent = "The farthest throws.";
    render(remote.entries);
    return;
  }
  note.textContent = "This browser only";
  render(readLocalBoard());
}

document.querySelector("#board-refresh").addEventListener("click", load);
load();
