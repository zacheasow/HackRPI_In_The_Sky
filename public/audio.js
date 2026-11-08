const IDLE_POS_KEY = "aerogami.idle.t";

const windSound = new Audio("audio/wind.mp3");
windSound.loop = true;
windSound.preload = "auto";
windSound.volume = 1;

const idleSound = new Audio("audio/idle.mp4");
idleSound.loop = true;
idleSound.preload = "auto";
idleSound.volume = 1;

const plopSound = new Audio("audio/plop.mp3");
plopSound.preload = "auto";
plopSound.volume = 1;

function playTrack(track) {
  if (!track.paused) return;
  track.play().catch(() => {});
}

function haltTrack(track) {
  track.pause();
  track.currentTime = 0;
}

function readSavedPos() {
  try {
    const saved = Number(localStorage.getItem(IDLE_POS_KEY));
    return Number.isFinite(saved) && saved > 0.25 ? saved : 0;
  } catch {
    return 0;
  }
}

export function rememberIdlePos() {
  try {
    const t = idleSound.currentTime || 0;
    if (t > 0.05 || !idleSound.paused) {
      localStorage.setItem(IDLE_POS_KEY, String(t));
    }
  } catch {
    /* private mode */
  }
}

function seekIdle(saved) {
  if (!(saved > 0.25)) return;
  try {
    const duration = idleSound.duration;
    const next = Number.isFinite(duration) && duration > 0 ? saved % duration : saved;
    if (Math.abs((idleSound.currentTime || 0) - next) > 0.3) {
      idleSound.currentTime = next;
    }
  } catch {
    /* seek not ready yet */
  }
}

function fadeIdleIn() {
  idleSound.volume = 0;
  const started = performance.now();
  const step = (now) => {
    const u = Math.min(1, (now - started) / 450);
    idleSound.volume = u;
    if (u < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function startFlightAudio() {
  rememberIdlePos();
  idleSound.pause();
  playTrack(windSound);
}

export function startIdleAudio() {
  haltTrack(windSound);
  if (!idleSound.paused) {
    idleSound.volume = 1;
    return;
  }

  const saved = readSavedPos();
  fadeIdleIn();

  // MP4 often ignores seeks made before play() — play first, then seek.
  idleSound
    .play()
    .then(() => {
      seekIdle(saved);
      requestAnimationFrame(() => seekIdle(saved));
      idleSound.addEventListener("loadedmetadata", () => seekIdle(saved), { once: true });
    })
    .catch(() => {});
}

export function stopAllAudio() {
  rememberIdlePos();
  haltTrack(windSound);
  haltTrack(idleSound);
}

export function playPlop() {
  plopSound.currentTime = 0;
  plopSound.play().catch(() => {});
}

/** Browser autoplay unlock — call once from home or fly. */
export function unlockAudioOnGesture(isFlying = () => false) {
  const unlock = () => {
    if (isFlying()) startFlightAudio();
    else startIdleAudio();
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
}

function isLeaderboardPath(pathname) {
  return /\/leaderboard\.html$/i.test(pathname) || /\/leaderboard\/?$/i.test(pathname);
}

/** Keep the same Audio instance by soft-loading the leaderboard page. */
export function bindSoftLeaderboardNav() {
  if (bindSoftLeaderboardNav.bound) return;
  bindSoftLeaderboardNav.bound = true;

  document.addEventListener(
    "click",
    (event) => {
      const link = event.target.closest?.("a[href]");
      if (!link || event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (link.target && link.target !== "_self") return;

      let url;
      try {
        url = new URL(link.href, location.href);
      } catch {
        return;
      }
      if (url.origin !== location.origin || !isLeaderboardPath(url.pathname)) return;
      if (isLeaderboardPath(location.pathname)) return;

      event.preventDefault();
      rememberIdlePos();
      void softOpenLeaderboard(url);
    },
    true
  );
}

async function softOpenLeaderboard(url) {
  try {
    const response = await fetch(url.pathname + url.search, { credentials: "same-origin" });
    if (!response.ok) {
      location.assign(url.href);
      return;
    }
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const script of doc.body.querySelectorAll("script")) script.remove();

    document.title = doc.title || "Leaderboard — Aerogami";
    document.body.className = doc.body.className || "board";
    document.body.replaceChildren(...[...doc.body.childNodes]);
    history.pushState({ soft: "leaderboard" }, "", url.pathname + url.search);

    startIdleAudio();
    const board = await import("./leaderboard.js");
    board.bootLeaderboard?.();
  } catch {
    location.assign(url.href);
  }
}

idleSound.addEventListener("timeupdate", rememberIdlePos);
window.addEventListener("pagehide", rememberIdlePos);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") rememberIdlePos();
}, true);
document.addEventListener("click", (event) => {
  if (event.target.closest?.("a[href]")) rememberIdlePos();
}, true);

window.addEventListener("popstate", () => {
  rememberIdlePos();
  if (!isLeaderboardPath(location.pathname)) location.reload();
});
