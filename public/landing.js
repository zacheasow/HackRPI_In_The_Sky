import { leaderboard } from "./api.js";
import { defaultLaunch, defaultPlane } from "./plane.js";
import { simulate } from "./physics.js";
import { FlightView } from "./render.js";

const PAUSE_MS = 1500;
const result = simulate(defaultPlane(), defaultLaunch(), { mode: "off" });
const view = new FlightView(document.querySelector("#flight"));
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

document.querySelector("#preview-caption").textContent = `Default glider, ${result.distance.toFixed(2)} m`;

function replay() {
  if (reduce) {
    view.showFinished(result);
    return;
  }
  view.play(result, (progress) => {
    if (progress >= 1) window.setTimeout(replay, PAUSE_MS);
  });
}

view.resize();
replay();

const line = document.querySelector("#top-flight");
const board = await leaderboard(1);
const best = board?.ok ? board.entries?.[0] : null;
if (best && best.name && Number.isFinite(Number(best.distance))) {
  line.textContent = `Top flight: ${best.name}, ${Number(best.distance).toFixed(1)} m`;
  line.hidden = false;
}
