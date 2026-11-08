import { leaderboard } from "./api.js";
import { bindSoftLeaderboardNav, startIdleAudio, unlockAudioOnGesture } from "./audio.js";
import { bindEnterFly } from "./enter.js";
import { defaultPlane } from "./plane.js";
import { FlightView } from "./render.js";

let homeView = null;
let reduceListener = null;
let resizeListener = null;

export function syncHomePlaneBand(view = homeView) {
  const sky = document.querySelector("#home-sky");
  const lane = document.querySelector(".home-sky-lane");
  if (!view || !lane || !sky) return;
  view.resize();
  const laneRect = lane.getBoundingClientRect();
  const skyRect = sky.getBoundingClientRect();
  if (skyRect.height < 1 || laneRect.height < 1 || !Number.isFinite(sky.height)) {
    view.ambientAlt = 1.85;
    if (view.scene && view.ambient) {
      view.setAmbientBandFromCanvasY(sky.height * 0.48);
    }
    return;
  }
  const band = window.innerWidth <= 860 ? 0.22 : 0.68;
  const midCssY = laneRect.top + laneRect.height * band - skyRect.top;
  const canvasY = (midCssY / skyRect.height) * sky.height;
  if (!Number.isFinite(canvasY)) {
    view.ambientAlt = 1.85;
    return;
  }
  view.setAmbientBandFromCanvasY(canvasY);
}

async function fillTopFlight() {
  const line = document.querySelector("#top-flight");
  if (!line) return;
  const board = await leaderboard(1);
  const best = board?.ok ? board.entries?.[0] : null;
  if (best && best.name && Number.isFinite(Number(best.distance))) {
    line.textContent = `Top flight: ${best.name}, ${Number(best.distance).toFixed(1)} m`;
    line.hidden = false;
    if (homeView) syncHomePlaneBand(homeView);
  }
}

/** Boot (or re-boot) the home ambient sky + enter-fly binding. */
export function bootHome(options = {}) {
  const sky = document.querySelector("#home-sky");
  if (!sky) throw new Error("home sky missing");

  if (homeView) {
    try {
      homeView.dispose();
    } catch {
      /* ignore */
    }
    homeView = null;
  }
  if (resizeListener) {
    window.removeEventListener("resize", resizeListener);
    resizeListener = null;
  }
  if (reduceListener) {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduce.removeEventListener("change", reduceListener);
    reduceListener = null;
  }

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  homeView = new FlightView(sky);
  homeView.planeVisible = options.planeVisible !== false;
  homeView.ambientAlt = Number.isFinite(options.altitude) ? options.altitude : 1.85;
  homeView.showAmbient(defaultPlane(), {
    freeze: options.freeze ?? reduce.matches,
    altitude: homeView.ambientAlt,
  });

  resizeListener = () => syncHomePlaneBand(homeView);
  window.addEventListener("resize", resizeListener);

  reduceListener = () => {
    homeView.showAmbient(defaultPlane(), {
      freeze: reduce.matches,
      altitude: Number.isFinite(homeView.ambientAlt) ? homeView.ambientAlt : 1.85,
    });
    syncHomePlaneBand(homeView);
  };
  reduce.addEventListener("change", reduceListener);

  syncHomePlaneBand(homeView);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      syncHomePlaneBand(homeView);
    });
  });

  bindEnterFly(homeView);
  startIdleAudio();
  unlockAudioOnGesture();
  bindSoftLeaderboardNav();
  void fillTopFlight();
  return { view: homeView };
}

if (document.body.classList.contains("home") && document.querySelector("#home-sky")) {
  bootHome();
}
