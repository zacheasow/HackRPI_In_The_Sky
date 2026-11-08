/**
 * Home ↔ Fly slide transition with a shared plane bridge.
 * Sky/clouds stay fixed; only the UI panels slide.
 */

import { paintPlaneSprite } from "./render.js";

const DURATION_MS = 1100;
const PANEL_EASE = "cubic-bezier(0.45, 0, 0.55, 1)";
const STORAGE_KEY = "clouds.enterFly";

let entering = false;
let unbindEnter = null;
let unbindReturn = null;
let unbindPop = null;
let simHtmlCache = null;
let homeHtmlCache = null;
let mainModPromise = null;
let landingModPromise = null;

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function setPanelY(el, pct) {
  el.style.transform = `translate3d(0, ${pct}%, 0)`;
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function replayFlyTitle() {
  if (prefersReducedMotion()) return;
  for (const node of document.querySelectorAll(".fly-title h1, .fly-title .lede")) {
    node.style.animation = "none";
    void node.offsetWidth;
    node.style.animation = "";
  }
}

function isFlyHref(href) {
  try {
    const url = new URL(href, window.location.href);
    return /\/sim\.html?$/i.test(url.pathname) || url.pathname.endsWith("/sim.html");
  } catch {
    return false;
  }
}

function isHomeHref(href) {
  try {
    const url = new URL(href, window.location.href);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    return path === "/" || path.endsWith("/index.html");
  } catch {
    return false;
  }
}

/** Pre-render the plane once; animate with CSS transform on the compositor. */
function makePlaneBridge(dpr, start, end) {
  const refSize = Math.max(start.size, end.size, 48);
  const pad = refSize * 1.35;
  const css = pad * 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(css * dpr));
  canvas.height = Math.max(1, Math.ceil(css * dpr));
  canvas.style.width = `${css}px`;
  canvas.style.height = `${css}px`;
  canvas.style.display = "block";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  paintPlaneSprite(ctx, pad, pad, 0, refSize, dpr);

  const wrap = document.createElement("div");
  wrap.className = "sky-bridge-plane";
  wrap.setAttribute("aria-hidden", "true");
  wrap.append(canvas);

  const place = (pose) => {
    const scale = pose.size / refSize;
    wrap.style.transform = `translate3d(${pose.x - pad}px, ${pose.y - pad}px, 0) rotate(${pose.theta}rad) scale(${scale})`;
  };

  place(start);
  return { wrap, place, pad, refSize };
}

/**
 * Panels + plane all use the same CSS transition on the compositor thread.
 * Ambient sky keeps scrolling in lite mode on the main thread.
 */
function runSlide(planeBridge, start, end, homePanel, simPanel, toFly) {
  homePanel.style.transition = "none";
  simPanel.style.transition = "none";
  planeBridge.wrap.style.transition = "none";
  setPanelY(homePanel, toFly ? 0 : -100);
  setPanelY(simPanel, toFly ? 100 : 0);
  planeBridge.place(start);
  void homePanel.offsetWidth;

  const transition = `transform ${DURATION_MS}ms ${PANEL_EASE}`;
  homePanel.style.transition = transition;
  simPanel.style.transition = transition;
  planeBridge.wrap.style.transition = transition;
  setPanelY(homePanel, toFly ? -100 : 0);
  setPanelY(simPanel, toFly ? 0 : 100);
  planeBridge.place(end);

  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      homePanel.removeEventListener("transitionend", onEnd);
      resolve();
    };
    const onEnd = (event) => {
      if (event.target !== homePanel || event.propertyName !== "transform") return;
      done();
    };
    homePanel.addEventListener("transitionend", onEnd);
    window.setTimeout(done, DURATION_MS + 80);
  });
}

async function loadSimHtml() {
  if (simHtmlCache && simHtmlCache.includes('id="fly-sky"')) return simHtmlCache;
  const html = await fetch("/sim.html", { credentials: "same-origin" }).then((res) => {
    if (!res.ok) throw new Error("sim fetch failed");
    return res.text();
  });
  simHtmlCache = html;
  return html;
}

async function loadHomeHtml() {
  if (homeHtmlCache) return homeHtmlCache;
  const html = await fetch("/", { credentials: "same-origin" }).then((res) => {
    if (!res.ok) throw new Error("home fetch failed");
    return res.text();
  });
  homeHtmlCache = html;
  return html;
}

function preloadMain() {
  if (!mainModPromise) mainModPromise = import("./main.js");
  return mainModPromise;
}

function preloadLanding() {
  if (!landingModPromise) landingModPromise = import("./landing.js");
  return landingModPromise;
}

function stripSky(root, selector) {
  const node = root?.querySelector?.(selector);
  if (node) node.remove();
  return root;
}

function asStaySky(canvas, id, className) {
  if (!canvas) return null;
  canvas.id = id;
  canvas.className = `sky-stay ${className}`;
  canvas.setAttribute("aria-hidden", "true");
  return canvas;
}

/** Warm caches so the first click does not wait on network. */
export function prefetchTransitions() {
  void loadSimHtml().catch(() => {});
  void loadHomeHtml().catch(() => {});
  void preloadMain().catch(() => {});
  void preloadLanding().catch(() => {});
}

export function bindEnterFly(homeView) {
  if (unbindEnter) unbindEnter();
  prefetchTransitions();
  const onClick = (event) => {
    if (!document.body.classList.contains("home")) return;
    const link = event.target.closest("a[href]");
    if (!link || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!isFlyHref(link.getAttribute("href"))) return;
    event.preventDefault();
    enterFly(homeView);
  };
  document.addEventListener("click", onClick, true);
  unbindEnter = () => {
    document.removeEventListener("click", onClick, true);
    unbindEnter = null;
  };
}

export function bindReturnHome(simView) {
  if (unbindReturn) unbindReturn();
  prefetchTransitions();
  const onClick = (event) => {
    if (document.body.classList.contains("home")) return;
    if (document.body.classList.contains("entering-fly")) return;
    const link = event.target.closest("a[href]");
    if (!link || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!isHomeHref(link.getAttribute("href"))) return;
    event.preventDefault();
    enterHome(simView);
  };
  document.addEventListener("click", onClick, true);
  unbindReturn = () => {
    document.removeEventListener("click", onClick, true);
    unbindReturn = null;
  };
}

export async function enterFly(homeView) {
  if (entering) return;
  if (prefersReducedMotion()) {
    window.location.href = "/sim.html";
    return;
  }

  entering = true;
  sessionStorage.setItem(STORAGE_KEY, "1");
  if (unbindEnter) unbindEnter();

  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  try {
    const from = homeView?.getPlaneViewportPose?.();
    homeView?.setPlaneVisible(false);
    homeView?.setLite?.(true);

    const [html, mainMod] = await Promise.all([loadSimHtml(), preloadMain()]);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const simPage = doc.querySelector(".page");
    if (!simPage) throw new Error("sim page missing");

    const sharedSky = document.querySelector("#home-sky");
    const homePage = document.querySelector(".page");
    const shell = document.createElement("div");
    shell.className = "sky-enter";
    shell.setAttribute("aria-busy", "true");

    // Sky stays fixed in the shell; UI panels slide over it.
    asStaySky(sharedSky, "home-sky", "home-sky");

    const homePanel = document.createElement("div");
    homePanel.className = "sky-panel sky-panel--home";
    if (homePage) homePanel.append(homePage);

    const simNode = document.importNode(simPage, true);
    stripSky(simNode, "#fly-sky");
    const simPanel = document.createElement("div");
    simPanel.className = "sky-panel sky-panel--sim is-measuring";
    simPanel.append(simNode);

    setPanelY(homePanel, 0);
    setPanelY(simPanel, 0);
    shell.append(...[sharedSky, homePanel, simPanel].filter(Boolean));

    document.body.classList.remove("home");
    document.body.classList.add("entering-fly");
    document.body.replaceChildren(shell);
    homeView?.resize?.();
    const fromLaidOut = homeView?.getPlaneViewportPose?.() || from;

    const { view: simView } = mainMod.bootSim({ planeVisible: false, skipAmbientWind: true });
    simView.resize();
    await nextFrame();
    simView.resize();
    const to = simView.getPlaneViewportPose();
    // Stop the idle flight redraw so it does not fight the slide for frames.
    simView.stop?.();

    simPanel.classList.remove("is-measuring");

    const start = fromLaidOut || to;
    const end = to || fromLaidOut;
    if (!start || !end) throw new Error("plane pose missing");

    const planeBridge = makePlaneBridge(dpr, start, end);
    shell.append(planeBridge.wrap);

    await runSlide(planeBridge, start, end, homePanel, simPanel, true);

    // Hand the same sky canvas to Fly, then resume ambient there.
    homeView?.setLite?.(false);
    homeView?.dispose?.();
    if (sharedSky) {
      sharedSky.id = "fly-sky";
      sharedSky.className = "fly-sky";
    }
    planeBridge.wrap.remove();
    homePanel.remove();
    simPanel.style.transition = "none";
    setPanelY(simPanel, 0);
    const finalPage = simPanel.querySelector(".page");
    if (finalPage && sharedSky) finalPage.prepend(sharedSky);
    document.body.classList.remove("entering-fly", "home");
    document.body.replaceChildren(finalPage || simPanel);
    shell.remove();
    replayFlyTitle();
    mainMod.bootFlySky();
    simView.setPlaneVisible(true);
    simView.resize();

    history.pushState({ intoSky: true }, "", "/sim.html");
    document.title = doc.title || "Aerogami";
    sessionStorage.removeItem(STORAGE_KEY);

    bindReturnHome(simView);
    if (unbindPop) unbindPop();
    const onPop = () => enterHome(simView, { fromPopState: true });
    window.addEventListener("popstate", onPop);
    unbindPop = () => {
      window.removeEventListener("popstate", onPop);
      unbindPop = null;
    };
    await wait(0);
  } catch (err) {
    console.error(err);
    sessionStorage.removeItem(STORAGE_KEY);
    window.location.href = "/sim.html";
  } finally {
    entering = false;
  }
}

export async function enterHome(simView, options = {}) {
  if (entering) return;
  if (prefersReducedMotion()) {
    window.location.href = "/";
    return;
  }

  entering = true;
  sessionStorage.setItem(STORAGE_KEY, "1");
  if (unbindPop) unbindPop();
  if (unbindReturn) unbindReturn();

  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  try {
    const from = simView?.getPlaneViewportPose?.();
    simView?.setPlaneVisible(false);

    const [html, landingMod, mainMod] = await Promise.all([
      loadHomeHtml(),
      preloadLanding(),
      preloadMain(),
    ]);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const homePageNode = doc.querySelector(".page");
    if (!homePageNode) throw new Error("home page missing");

    const simPage = document.querySelector(".page");
    if (!simPage) throw new Error("sim page missing");

    const sharedSky = document.querySelector("#fly-sky");

    const shell = document.createElement("div");
    shell.className = "sky-enter";
    shell.setAttribute("aria-busy", "true");

    // Keep fly ambient alive until home boots on the same canvas (no freeze gap).
    asStaySky(sharedSky, "fly-sky", "fly-sky");

    const homePanel = document.createElement("div");
    homePanel.className = "sky-panel sky-panel--home is-measuring";
    homePanel.append(document.importNode(homePageNode, true));

    stripSky(simPage, "#fly-sky");
    const simPanel = document.createElement("div");
    simPanel.className = "sky-panel sky-panel--sim";
    simPanel.append(simPage);

    setPanelY(homePanel, 0);
    setPanelY(simPanel, 0);
    shell.append(...[sharedSky, homePanel, simPanel].filter(Boolean));

    document.body.classList.add("entering-fly");
    document.body.replaceChildren(shell);
    simView.resize();
    const fromLaidOut = simView.getPlaneViewportPose() || from;
    simView.stop?.();

    // Swap sky controllers with almost no pause; keep ambient unfrozen so mountains scroll.
    mainMod.disposeFlySky();
    if (sharedSky) {
      sharedSky.id = "home-sky";
      sharedSky.className = "sky-stay home-sky";
    }
    const { view: homeView } = landingMod.bootHome({ planeVisible: false, freeze: false });
    homeView.setLite?.(true);
    homeView.resize();
    landingMod.syncHomePlaneBand(homeView);
    await nextFrame();
    homeView.resize();
    landingMod.syncHomePlaneBand(homeView);
    const to = homeView.getPlaneViewportPose();

    homePanel.classList.remove("is-measuring");

    const start = fromLaidOut || to;
    const end = to || fromLaidOut;
    if (!start || !end) throw new Error("plane pose missing");

    const planeBridge = makePlaneBridge(dpr, start, end);
    shell.append(planeBridge.wrap);

    await runSlide(planeBridge, start, end, homePanel, simPanel, false);

    planeBridge.wrap.remove();
    simPanel.remove();

    const finalPage = homePanel.querySelector(".page");
    if (sharedSky) {
      sharedSky.id = "home-sky";
      sharedSky.className = "home-sky";
    }
    document.body.classList.remove("entering-fly");
    document.body.classList.add("home");
    document.body.replaceChildren(...[sharedSky, finalPage].filter(Boolean));
    shell.remove();

    homeView.setLite?.(false);
    homeView.setPlaneVisible(true);
    homeView.resize();
    landingMod.syncHomePlaneBand(homeView);

    mainMod.resetSimBoot();

    if (!options.fromPopState) {
      history.pushState({ intoSky: false }, "", "/");
    }
    document.title = doc.title || "Aerogami";
    sessionStorage.removeItem(STORAGE_KEY);

    bindEnterFly(homeView);
    await wait(0);
  } catch (err) {
    console.error(err);
    sessionStorage.removeItem(STORAGE_KEY);
    window.location.href = "/";
  } finally {
    entering = false;
  }
}
