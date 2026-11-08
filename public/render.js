/**
 * Side-view flight canvas: sky, ground, trajectory, and the paper airplane.
 */

import { windVelocity } from "./physics.js";

const PAPER = "#f7f4ee";
const CLOUD_COUNT = 14;

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Tiny seeded RNG so the sky stays stable across frames. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hillHeight(worldX) {
  return Math.exp(-((worldX + 0.2) ** 2) / 3.2) * 0.42;
}

/** Stable 0..1 hash from an integer blade index (not camera-dependent). */
function bladeNoise(index) {
  let t = Math.imul(index ^ 0x27d4eb2d, 0x165667b1) >>> 0;
  t = Math.imul(t ^ (t >>> 15), 0x27d4eb2d) >>> 0;
  return t / 4294967296;
}

/** Endless rolling ground for the home flyby (flight sim still uses hillHeight). */
function rollingTerrain(worldX) {
  let h = 0.1;
  h += Math.sin(worldX * 0.32) * 0.09;
  h += Math.sin(worldX * 0.85 + 1.9) * 0.05;
  h += Math.sin(worldX * 1.55 + 0.6) * 0.025;
  const spacing = 2.6;
  const cell = Math.floor(worldX / spacing);
  const local = worldX / spacing - cell;
  const roll = bladeNoise(cell + 9001);
  if (roll > 0.28) {
    const amp = 0.06 + roll * 0.16;
    const width = 0.18 + bladeNoise(cell + 42) * 0.28;
    const center = 0.25 + bladeNoise(cell + 7) * 0.5;
    h += amp * Math.exp(-((local - center) ** 2) / (2 * width * width));
  }
  // Occasional sharper bump.
  if (bladeNoise(cell + 4243) > 0.78) {
    const c2 = 0.45 + bladeNoise(cell + 11) * 0.2;
    h += 0.1 * Math.exp(-((local - c2) ** 2) / 0.02);
  }
  return Math.max(0.02, h);
}

function sampleAt(samples, time) {
  if (!samples.length) return null;
  if (time <= samples[0].t) return samples[0];
  const last = samples[samples.length - 1];
  if (time >= last.t) return last;

  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t < time) lo = mid + 1;
    else hi = mid;
  }
  const b = samples[lo];
  const a = samples[lo - 1] || b;
  const span = b.t - a.t || 1;
  const f = Math.min(1, Math.max(0, (time - a.t) / span));
  return {
    t: time,
    x: lerp(a.x, b.x, f),
    y: lerp(a.y, b.y, f),
    theta: lerp(a.theta, b.theta, f),
    vx: lerp(a.vx, b.vx, f),
    vy: lerp(a.vy, b.vy, f),
  };
}

function formatMeters(value) {
  return `${value.toFixed(1)} m`;
}

const AMBIENT_SCROLL = 1.65; // m/s camera travel — scenery streams right-to-left

function ambientPose(time, viewX = -1.5, alt = 1.85) {
  // Keep the plane in the open sky lane (right of the hero card).
  const mid = viewX + 5.6;
  const bob = Math.sin(time * 0.85) * 0.08 + Math.sin(time * 0.37) * 0.03;
  const x = mid + Math.sin(time * 0.4) * 0.55;
  const base = Number.isFinite(alt) ? alt : 1.85;
  const y = base + bob;
  const bank = Math.sin(time * 1.05) * 0.1;
  const climb = Math.cos(time * 0.85) * 0.05;
  return {
    t: time,
    x,
    y,
    theta: 0.04 + climb + bank,
    vx: AMBIENT_SCROLL,
    vy: Math.cos(time * 0.85) * 0.12,
  };
}

/** Draw the paper plane in CSS-pixel space (bridge overlay / shared transition). */
export function paintPlaneSprite(ctx, x, y, theta, sizePx, dpr = 1) {
  const drawScale = Math.max(sizePx / 0.22, 1);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(drawScale, -drawScale);
  ctx.rotate(theta);
  ctx.lineJoin = "round";
  ctx.lineWidth = 1.35 / drawScale;
  ctx.beginPath();
  ctx.moveTo(0.11, 0);
  ctx.lineTo(0.02, 0.012);
  ctx.lineTo(-0.03, 0.016);
  ctx.lineTo(-0.09, 0.048);
  ctx.lineTo(-0.108, 0.014);
  ctx.lineTo(-0.05, 0.006);
  ctx.lineTo(-0.01, -0.012);
  ctx.closePath();
  ctx.fillStyle = PAPER;
  ctx.strokeStyle = "rgba(28, 38, 30, 0.62)";
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0.08, 0.001);
  ctx.lineTo(-0.06, 0.006);
  ctx.strokeStyle = "rgba(28, 38, 30, 0.4)";
  ctx.stroke();
  ctx.restore();
  void dpr;
}

export class FlightView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.raf = 0;
    this.loopId = 0;
    this.dpr = 1;
    this.scene = null;
    this.onProgress = null;
    this.viewX = null;
    this.viewY = null;
    this.clouds = null;
    this.planeVisible = true;
    this.ambient = false;
    this.ambientAlt = 1.85;
    this.lite = false;
    this._liteTick = 0;
    this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

    this.resize = this.resize.bind(this);
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(canvas);
    window.addEventListener("resize", this.resize);
  }

  setPlaneVisible(visible) {
    this.planeVisible = Boolean(visible);
    this.redraw();
  }

  /** Cheaper ambient draws during page transitions (skip blur, thinner mountains). */
  setLite(lite) {
    this.lite = Boolean(lite);
    this._liteTick = 0;
  }

  dispose() {
    this.stop();
    this.ambient = false;
    if (this.observer) this.observer.disconnect();
    window.removeEventListener("resize", this.resize);
  }

  ensureClouds(width, height) {
    if (this.clouds && this.clouds.width === width && this.clouds.height === height) {
      return this.clouds.list;
    }
    const rng = makeRng(0xc10d5 ^ Math.floor(width) ^ (Math.floor(height) << 9));
    const list = [];
    for (let i = 0; i < CLOUD_COUNT; i += 1) {
      list.push({
        x: rng() * width,
        y: height * (0.06 + rng() * 0.38),
        scale: 0.35 + rng() * 1.35,
        alpha: 0.28 + rng() * 0.5,
        speed: 6 + rng() * 28,
        stretch: 0.75 + rng() * 0.7,
      });
    }
    this.clouds = { width, height, list };
    return list;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(rect.width * dpr));
    const height = Math.max(1, Math.floor(rect.height * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.dpr = dpr;
    this.redraw();
  }

  showIdle(plane, launch, wind) {
    const nextWind = wind || { mode: "off", steady: 0, phases: [0, 0, 0, 0] };
    const idleAlready = this.scene && !this.scene.live && !this.ambient;
    if (!idleAlready) this.stop();
    this.ambient = false;
    const time = idleAlready ? this.scene.time : 0;
    if (!idleAlready) {
      this.viewX = null;
      this.viewY = null;
    }
    const angle = (launch.angleDeg * Math.PI) / 180;
    this.scene = {
      samples: [
        {
          t: 0,
          x: 0,
          y: launch.height,
          theta: angle,
          vx: 0,
          vy: 0,
        },
      ],
      time,
      duration: 0,
      distance: 0,
      bodyLength: plane.bodyLength,
      live: false,
      wind: nextWind,
    };
    if (nextWind.mode === "off" || this.reduced.matches) {
      if (idleAlready) this.stop();
      this.redraw();
      return;
    }
    this.redraw();
    if (!this.raf) {
      const started = performance.now() - time * 1000;
      this.beginLoop((now) => {
        if (!this.scene || this.scene.live || this.ambient) return false;
        this.scene.time = (now - started) / 1000;
        this.redraw();
        return true;
      });
    }
  }

  groundAt(worldX) {
    return this.ambient ? rollingTerrain(worldX) : hillHeight(worldX);
  }

  /** Place the home plane on a canvas Y (device pixels) — used to sit in the UI sky lane. */
  setAmbientBandFromCanvasY(canvasY) {
    if (!this.canvas || !this.canvas.height || !Number.isFinite(canvasY)) return;
    const bounds = {
      minX: this.viewX ?? -1.5,
      maxX: (this.viewX ?? -1.5) + 9,
      maxY: this.viewY ?? 3.55,
    };
    const camera = this.camera(bounds, this.canvas.width, this.canvas.height);
    if (!(camera.scale > 0) || !Number.isFinite(camera.offsetY)) return;
    const worldY = (camera.offsetY - canvasY) / camera.scale;
    if (!Number.isFinite(worldY)) return;
    // Keep the plane clearly above the grass and below the top UI.
    this.ambientAlt = Math.min(2.45, Math.max(1.35, worldY));
    this.planeVisible = true;
    if (this.scene && this.ambient) {
      this.scene.samples = [ambientPose(this.scene.time || 0, this.viewX ?? -1.5, this.ambientAlt)];
      this.redraw();
    }
  }

  /** Home-screen loop: camera scrolls forward over bumpy ground; plane banks gently. */
  showAmbient(plane, options = {}) {
    this.stop();
    this.ambient = true;
    this.viewX = -1.5;
    this.viewY = 3.55;
    if (Number.isFinite(options.altitude)) this.ambientAlt = options.altitude;
    const bodyLength = plane?.bodyLength || 0.22;
    const wind = { mode: "off", steady: 0, phases: [0, 0, 0, 0] };
    const freeze = this.reduced.matches || options.freeze;
    const pose0 = freeze
      ? ambientPose(1.1, this.viewX, this.ambientAlt)
      : ambientPose(0, this.viewX, this.ambientAlt);
    this.scene = {
      samples: [pose0],
      time: freeze ? 1.1 : 0,
      duration: 0,
      distance: 0,
      bodyLength,
      live: false,
      wind,
    };
    this.redraw();
    if (freeze) return;
    const started = performance.now();
    this.beginLoop((now) => {
      if (!this.scene || !this.ambient) return false;
      this.scene.time = (now - started) / 1000;
      this.viewX = -1.5 + this.scene.time * AMBIENT_SCROLL;
      this.scene.samples = [ambientPose(this.scene.time, this.viewX, this.ambientAlt)];
      // Lite mode: still scroll scenery, but only paint every other frame.
      if (this.lite) {
        this._liteTick = (this._liteTick + 1) % 2;
        if (this._liteTick !== 0) return true;
      }
      this.redraw();
      return true;
    });
  }

  /** Plane pose in viewport CSS pixels for the shared transition bridge. */
  getPlaneViewportPose() {
    if (!this.scene || !this.canvas) return null;
    const pose = sampleAt(this.scene.samples, this.scene.time) || this.scene.samples[0];
    if (!pose) return null;
    const bounds = this.ambient
      ? { minX: this.viewX, maxX: this.viewX + 9, maxY: this.viewY }
      : this.followBounds(pose);
    const camera = this.camera(bounds, this.canvas.width, this.canvas.height);
    const minPx = this.ambientPlanePx();
    const drawScale = Math.max(camera.scale, (minPx * this.dpr) / 0.22);
    const rect = this.canvas.getBoundingClientRect();
    const sx = rect.width / Math.max(1, this.canvas.width);
    const sy = rect.height / Math.max(1, this.canvas.height);
    return {
      x: rect.left + camera.toX(pose.x) * sx,
      y: rect.top + camera.toY(pose.y) * sy,
      theta: pose.theta,
      size: drawScale * 0.22 * sx,
    };
  }

  /** Home plane fills more of the viewport; flight/idle stays the original size. */
  ambientPlanePx() {
    if (!this.ambient) return 52;
    const cssW = this.canvas.width / Math.max(this.dpr, 1);
    return Math.max(260, cssW * 0.44);
  }

  showSamples(samples, time, options = {}) {
    this.stop();
    this.ambient = false;
    this.viewX = null;
    this.viewY = null;
    const rows = Array.isArray(samples) ? samples : [];
    const last = rows.length ? Number(rows[rows.length - 1].t) : 0;
    const duration = Math.max(Number.isFinite(options.duration) ? options.duration : last, 0.01);
    this.scene = {
      samples: rows,
      time: Math.min(duration, Math.max(0, time || 0)),
      duration,
      distance: options.distance || 0,
      bodyLength: options.bodyLength || 0.22,
      live: false,
      wind: { mode: "off", steady: 0, phases: [0, 0, 0, 0] },
      ghost: Array.isArray(options.ghost) ? options.ghost : null,
    };
    this.compareFrame = null;
    this.redraw();
  }

  seek(time) {
    if (!this.scene || this.ambient) return;
    const duration = this.scene.duration || 0.01;
    this.scene.time = Math.min(duration, Math.max(0, Number(time) || 0));
    this.redraw();
  }

  play(result, onProgress) {
    this.stop();
    this.viewX = null;
    this.viewY = null;
    this.onProgress = onProgress || null;
    this.scene = {
      samples: result.samples,
      time: 0,
      duration: Math.max(result.flightTime, 0.01),
      distance: result.distance,
      bodyLength: result.plane.bodyLength,
      live: true,
      wind: result.wind,
    };
    const started = performance.now();
    this.beginLoop((now) => {
      const u = Math.min(1, (now - started) / (this.scene.duration * 1000));
      this.scene.time = u * this.scene.duration;
      this.redraw();
      if (this.onProgress) this.onProgress(u, this.scene.time);
      return u < 1;
    });
  }

  stop() {
    this.loopId += 1;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.onProgress = null;
  }

  beginLoop(step) {
    const id = this.loopId;
    const loop = (now) => {
      if (id !== this.loopId) return;
      if (step(now) === false) {
        this.raf = 0;
        return;
      }
      if (id !== this.loopId) return;
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  showFinished(result) {
    this.stop();
    this.viewX = null;
    this.viewY = null;
    const duration = Math.max(result.flightTime, 0.01);
    this.scene = {
      samples: result.samples,
      time: duration,
      duration,
      distance: result.distance,
      bodyLength: result.plane.bodyLength,
      live: true,
      wind: result.wind,
    };
    this.redraw();
  }

  redraw() {
    if (!this.scene || !this.ctx) return;
    const ctx = this.ctx;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const pose = sampleAt(this.scene.samples, this.scene.time) || this.scene.samples[0];
    const ghostPose = this.scene.ghost ? sampleAt(this.scene.ghost, this.scene.time) : null;
    const bounds = this.ambient
      ? { minX: this.viewX ?? -1.5, maxX: (this.viewX ?? -1.5) + 9, maxY: this.viewY ?? 3.55 }
      : ghostPose && pose
        ? this.compareFrameFor(pose, ghostPose)
        : this.followBounds(pose);
    const driftTime = this.reduced.matches ? 0 : this.scene.time || 0;

    ctx.clearRect(0, 0, width, height);
    const camera = this.camera(bounds, width, height);
    this.drawSky(ctx, width, height);
    this.drawMountains(ctx, width, height, camera, driftTime);
    this.drawClouds(ctx, width, height, driftTime);
    const wind = this.scene.wind || { mode: "off", steady: 0, phases: [0, 0, 0, 0] };
    const velocity = windVelocity(wind, this.scene.time || 0);
    if (!this.ambient) this.drawWindStreaks(ctx, width, height, velocity, driftTime);
    if (this.ambient) this.drawMountainFloor(ctx, width, height);
    else this.drawGround(ctx, camera, bounds, driftTime);
    if (this.scene.ghost) {
      this.drawColoredTrail(ctx, camera, this.scene.samples, this.scene.time, "#2c6cb0");
      this.drawColoredTrail(ctx, camera, this.scene.ghost, this.scene.time, "#d2652d");
    } else if (!this.ambient) this.drawTrail(ctx, camera, this.scene.samples, this.scene.time);
    if (pose && this.planeVisible) this.drawPlane(ctx, camera, pose, this.scene.bodyLength);
    if (ghostPose && this.planeVisible) this.drawPlane(ctx, camera, ghostPose, this.scene.bodyLength);
    if (!this.ambient) this.drawCaption(ctx, width, pose ? pose.x : 0, this.scene.live, velocity.x);
  }

  // shortcut: compare zoom stays between a 9 m and 80 m window, widen the max if flights separate further.
  compareFrameFor(a, b) {
    const pad = 1.5;
    const low = Math.min(a.x, b.x);
    const high = Math.max(a.x, b.x);
    const span = Math.min(80, Math.max(9, high - low + pad * 2));
    const center = (low + high) / 2;
    const target = {
      minX: center - span / 2,
      maxX: center + span / 2,
      maxY: Math.max(3.4, a.y + 1.15, b.y + 1.15),
    };
    if (!this.compareFrame || this.reduced.matches) {
      this.compareFrame = target;
      return this.compareFrame;
    }
    const ease = 0.08;
    this.compareFrame = {
      minX: this.compareFrame.minX + (target.minX - this.compareFrame.minX) * ease,
      maxX: this.compareFrame.maxX + (target.maxX - this.compareFrame.maxX) * ease,
      maxY: this.compareFrame.maxY + (target.maxY - this.compareFrame.maxY) * ease,
    };
    return this.compareFrame;
  }

  followBounds(pose) {
    const x = pose ? pose.x : 0;
    const y = pose ? pose.y : 1.5;
    const targetX = Math.max(-1.4, x - 2.6);
    const targetY = Math.max(3.4, y + 1.15);
    if (this.viewX == null || this.reduced.matches) {
      this.viewX = targetX;
      this.viewY = targetY;
    } else {
      this.viewX += (targetX - this.viewX) * 0.08;
      this.viewY += (targetY - this.viewY) * 0.08;
    }
    return {
      minX: this.viewX,
      maxX: this.viewX + 9,
      maxY: this.viewY,
    };
  }

  camera(bounds, width, height) {
    const worldW = Math.max(1, bounds.maxX - bounds.minX);
    const groundBand = Math.max(height * 0.18, 56 * this.dpr);
    const topPad = height * 0.06;
    const sidePad = width * 0.04;
    const scaleX = (width - sidePad * 2) / worldW;
    const scaleY = (height - groundBand - topPad) / Math.max(bounds.maxY, 0.5);
    const scale = Math.max(1, Math.min(scaleX, scaleY));
    const offsetX = sidePad - bounds.minX * scale;
    const offsetY = height - groundBand;
    return {
      scale,
      offsetX,
      toX: (x) => offsetX + x * scale,
      toY: (y) => offsetY - y * scale,
    };
  }

  drawSky(ctx, width, height) {
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, "#6ea8c9");
    sky.addColorStop(0.42, "#b7d7ea");
    sky.addColorStop(0.72, "#e7f0e4");
    sky.addColorStop(1, "#f3e6d4");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);

    const sunX = width * 0.78;
    const sunY = height * 0.14;
    const sun = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, width * 0.22);
    sun.addColorStop(0, "rgba(255, 236, 196, 0.9)");
    sun.addColorStop(0.35, "rgba(255, 220, 160, 0.28)");
    sun.addColorStop(1, "rgba(255, 220, 160, 0)");
    ctx.fillStyle = sun;
    ctx.fillRect(0, 0, width, height);

    const haze = ctx.createLinearGradient(0, height * 0.5, 0, height * 0.86);
    haze.addColorStop(0, "rgba(243, 230, 212, 0)");
    haze.addColorStop(1, "rgba(243, 230, 212, 0.55)");
    ctx.fillStyle = haze;
    ctx.fillRect(0, height * 0.5, width, height * 0.36);
  }

  drawClouds(ctx, width, height, time) {
    const clouds = this.ensureClouds(width, height);
    const span = width + 220 * this.dpr;
    const pad = 110 * this.dpr;
    for (const cloud of clouds) {
      const drift = time * cloud.speed * this.dpr;
      const cycles = Math.floor((drift - cloud.x + pad) / span);
      if (cloud.spawn !== cycles) {
        cloud.spawn = cycles;
        // New size/height each time a cloud re-enters from the right.
        const rng = makeRng((cycles + 1) * 9973 + Math.floor(cloud.x) * 13);
        cloud.y = height * (0.05 + rng() * 0.4);
        cloud.scale = 0.3 + rng() * 1.45;
        cloud.alpha = 0.25 + rng() * 0.55;
        cloud.stretch = 0.7 + rng() * 0.8;
      }
      let x = cloud.x - drift;
      x = ((x % span) + span) % span - pad;
      this.drawCloud(ctx, x, cloud.y, cloud.scale, cloud.alpha, cloud.stretch);
    }
  }

  drawCloud(ctx, x, y, scale, alpha, stretch = 1) {
    const d = this.dpr * scale;
    const sx = stretch;
    const blobs = this.lite
      ? [
          [-48, 2, 42, 24, "rgba(255,255,255,0.72)"],
          [6, -8, 58, 28, "rgba(255,255,255,0.88)"],
          [52, 0, 36, 20, "rgba(255,255,255,0.7)"],
        ]
      : [
          [0, 10, 78, 26, "rgba(186, 198, 206, 0.45)"],
          [-48, 2, 42, 24, "rgba(255,255,255,0.72)"],
          [6, -8, 58, 28, "rgba(255,255,255,0.88)"],
          [52, 0, 36, 20, "rgba(255,255,255,0.7)"],
          [24, 8, 50, 18, "rgba(214, 224, 230, 0.4)"],
          [-20, -4, 28, 16, "rgba(255,255,255,0.55)"],
        ];
    ctx.save();
    ctx.translate(x, y);
    // Canvas blur filters are expensive; skip them while a page transition is running.
    if (!this.lite) ctx.filter = `blur(${(3.5 + scale) * this.dpr}px)`;
    ctx.globalAlpha = alpha;
    for (const [bx, by, rx, ry, fill] of blobs) {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.ellipse(bx * d * sx, by * d, rx * d * sx, ry * d, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Soft mist under ambient mountains (no grass/ground strip). */
  drawMountainFloor(ctx, width, height) {
    const floor = ctx.createLinearGradient(0, height * 0.72, 0, height);
    floor.addColorStop(0, "rgba(183, 215, 234, 0)");
    floor.addColorStop(1, "rgba(190, 205, 195, 0.28)");
    ctx.fillStyle = floor;
    ctx.fillRect(0, height * 0.72, width, height * 0.28);
  }

  drawMountains(ctx, width, height, camera, time) {
    const ridgeY = this.ambient ? height * 0.78 : camera.toY(0);
    const home = this.ambient;
    const layers = [
      {
        color: "#9bb8c9",
        mist: "rgba(183, 215, 234, 0.55)",
        base: ridgeY + (home ? 28 : 18) * this.dpr,
        amp: height * (home ? 0.42 : 0.22),
        speed: home ? 14 : 1.2,
        seed: 1103,
        step: home ? 0.042 : 0.11,
      },
      {
        color: "#849eb0",
        mist: "rgba(170, 200, 220, 0.4)",
        base: ridgeY + (home ? 16 : 12) * this.dpr,
        amp: height * (home ? 0.32 : 0.16),
        speed: home ? 22 : 1.8,
        seed: 2207,
        step: home ? 0.036 : 0.09,
      },
      {
        color: "#7f9e8a",
        mist: "rgba(200, 214, 190, 0.35)",
        base: ridgeY + (home ? 6 : 8) * this.dpr,
        amp: height * (home ? 0.22 : 0.14),
        speed: home ? 36 : 2.4,
        seed: 3341,
        step: home ? 0.03 : 0.1,
      },
    ];
    if (home && !this.lite) {
      layers.push({
        color: "#6a8a74",
        mist: "rgba(180, 200, 170, 0.3)",
        base: ridgeY + 2 * this.dpr,
        amp: height * 0.15,
        speed: 52,
        seed: 4489,
        step: 0.024,
      });
    }

    for (const layer of layers) {
      const stepMul = this.lite ? 1.85 : 1;
      const stepPx = Math.max(18 * this.dpr, width * layer.step * stepMul);
      const drift = time * layer.speed * this.dpr;
      const shift = ((drift % stepPx) + stepPx) % stepPx;
      const first = Math.floor(drift / stepPx) - 1;
      const count = Math.ceil(width / stepPx) + 3;

      ctx.beginPath();
      ctx.moveTo(-stepPx, height);
      ctx.lineTo(-stepPx, layer.base);
      for (let i = 0; i < count; i += 1) {
        const peakId = first + i;
        const x = i * stepPx - shift;
        const n = bladeNoise(peakId * 17 + layer.seed);
        const n2 = bladeNoise(peakId * 31 + layer.seed + 9);
        let h = 0.12 + n * 0.7;
        if (n2 > 0.78) h += 0.18 + n2 * 0.22;
        if (home && bladeNoise(peakId * 47 + layer.seed + 3) > 0.88) h += 0.28;
        h = Math.min(1.15, h);
        ctx.lineTo(x, layer.base - layer.amp * h);
      }
      ctx.lineTo(width + stepPx * 2, layer.base);
      ctx.lineTo(width + stepPx * 2, height);
      ctx.closePath();
      const fill = ctx.createLinearGradient(0, layer.base - layer.amp, 0, height);
      fill.addColorStop(0, layer.color);
      fill.addColorStop(0.7, layer.mist);
      fill.addColorStop(1, "rgba(243, 230, 212, 0.15)");
      ctx.fillStyle = fill;
      ctx.fill();
    }
  }

  drawWindStreaks(ctx, width, height, velocity, time) {
    const speed = Math.hypot(velocity.x, velocity.y);
    if (speed < 0.15) return;
    const dx = velocity.x / speed;
    const dy = -velocity.y / speed;
    const length = (18 + speed * 10) * this.dpr;
    const travel = time * (14 + speed * 10) * this.dpr;
    const skyBottom = height * 0.72;
    const alpha = Math.min(0.32, 0.12 + speed * 0.05);

    ctx.save();
    ctx.lineWidth = Math.max(1, this.dpr);
    ctx.lineCap = "round";
    for (let i = 0; i < 5; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        const originX = ((i + 0.2) / 5) * width;
        const originY = ((j + 0.35) / 3) * skyBottom;
        const xPeriod = width + length;
        let x = originX + dx * travel;
        let y = originY + dy * travel * 0.35;
        x = ((x % xPeriod) + xPeriod) % xPeriod;
        y = ((y % skyBottom) + skyBottom) % skyBottom;
        const fade = ctx.createLinearGradient(x, y, x - dx * length, y - dy * length);
        fade.addColorStop(0, `rgba(70, 98, 112, ${alpha.toFixed(3)})`);
        fade.addColorStop(1, "rgba(70, 98, 112, 0)");
        ctx.strokeStyle = fade;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - dx * length, y - dy * length);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawGround(ctx, camera, bounds, time) {
    const width = this.canvas.width;
    const height = this.canvas.height;
    const groundAt = (x) => this.groundAt(x);

    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let px = 0; px <= width; px += 6) {
      const worldX = (px - camera.offsetX) / camera.scale;
      ctx.lineTo(px, camera.toY(groundAt(worldX)));
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, camera.toY(0.5), 0, height);
    fill.addColorStop(0, "#b9d08a");
    fill.addColorStop(0.28, "#8fbc6a");
    fill.addColorStop(0.62, "#6f9a52");
    fill.addColorStop(1, "#4f7340");
    ctx.fillStyle = fill;
    ctx.fill();

    // Soft soil bands so the hillside reads as terrain, not a flat fill.
    ctx.save();
    ctx.globalAlpha = 0.18;
    for (let band = 0; band < 4; band += 1) {
      const y0 = camera.toY(0.08 - band * 0.05);
      const bandFill = ctx.createLinearGradient(0, y0, 0, height);
      bandFill.addColorStop(0, "rgba(90, 70, 42, 0)");
      bandFill.addColorStop(0.35, "rgba(90, 70, 42, 0.35)");
      bandFill.addColorStop(1, "rgba(60, 80, 45, 0)");
      ctx.fillStyle = bandFill;
      ctx.fillRect(0, y0, width, height - y0);
    }
    ctx.restore();

    ctx.beginPath();
    for (let px = 0; px <= width; px += 6) {
      const worldX = (px - camera.offsetX) / camera.scale;
      const y = camera.toY(groundAt(worldX));
      if (px === 0) ctx.moveTo(px, y);
      else ctx.lineTo(px, y);
    }
    ctx.strokeStyle = "rgba(220, 235, 190, 0.55)";
    ctx.lineWidth = Math.max(1, this.dpr);
    ctx.stroke();

    // Grass after the ridge stroke so embedded bases seal the seam.
    this.drawGrass(ctx, camera, width, time);

    if (this.ambient) return;

    ctx.fillStyle = "rgba(36, 48, 39, 0.45)";
    ctx.font = `${12 * this.dpr}px "Iowan Old Style", Palatino, Georgia, serif`;
    ctx.textAlign = "center";
    const start = Math.ceil(bounds.minX);
    for (let meter = start; meter <= bounds.maxX; meter += 1) {
      if (meter <= 0) continue;
      const x = camera.toX(meter);
      const y = camera.toY(groundAt(meter));
      ctx.fillText(String(meter), x, y + 18 * this.dpr);
    }
  }

  drawGrass(ctx, camera, width, time) {
    // World-space spacing keeps each blade tied to the hillside as the camera pans.
    // Screen-column sampling was the flicker: offsetX/scale remapped every px → new hash each frame.
    const worldStep = 0.055;
    const margin = worldStep * 2;
    const minWorld = (0 - camera.offsetX) / camera.scale - margin;
    const maxWorld = (width - camera.offsetX) / camera.scale + margin;
    const first = Math.floor(minWorld / worldStep);
    const last = Math.ceil(maxWorld / worldStep);
    const bladeH = 13 * this.dpr;
    const swayAmt = this.reduced.matches ? 0 : 3.2 * this.dpr;

    ctx.save();
    for (let i = first; i <= last; i += 1) {
      const n = bladeNoise(i);
      if (n < 0.22) continue;
      const n2 = bladeNoise(i + 7919);
      const n3 = bladeNoise(i + 104729);

      // Stagger in world X; bury bases below the ridge so no floating seam shows.
      const rootWorldX = i * worldStep + (n2 - 0.5) * worldStep * 1.15;
      const sx = camera.toX(rootWorldX);
      if (sx < -16 * this.dpr || sx > width + 16 * this.dpr) continue;

      const surfaceY = camera.toY(this.groundAt(rootWorldX));
      const embed = (4.5 + n3 * 5.5) * this.dpr;
      const rootY = surfaceY + embed;
      const above = bladeH * (0.45 + n * 1.25);
      const baseW = (2.4 + n2 * 3.2) * this.dpr;
      const restLean = (n - 0.5) * 5.5 * this.dpr;
      // Tip sway only; root stays fixed in world space.
      const sway = swayAmt * Math.sin(time * 2.15 + i * 0.63 + n * 4.1);
      const tipX = sx + restLean + sway;
      const tipY = surfaceY - above;

      const shade =
        n > 0.66
          ? "rgba(48, 98, 40, 0.92)"
          : n > 0.4
            ? "rgba(78, 128, 52, 0.9)"
            : "rgba(118, 162, 64, 0.84)";
      ctx.fillStyle = shade;
      ctx.beginPath();
      ctx.moveTo(sx - baseW, rootY);
      ctx.lineTo(sx + baseW, rootY);
      ctx.lineTo(tipX, tipY);
      ctx.closePath();
      ctx.fill();

      if (n > 0.68) {
        const twin = bladeNoise(i + 224737);
        const twinLean = restLean * -0.55 + (twin - 0.5) * 3 * this.dpr;
        const twinSway = sway * 0.7;
        const twinAbove = above * (0.55 + twin * 0.35);
        const twinW = baseW * 0.72;
        const twinRootY = rootY + (0.8 + twin * 2) * this.dpr;
        ctx.beginPath();
        ctx.moveTo(sx - twinW * 0.2, twinRootY);
        ctx.lineTo(sx + twinW, twinRootY);
        ctx.lineTo(sx + twinLean + twinSway, surfaceY - twinAbove);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  drawColoredTrail(ctx, camera, samples, time, color) {
    const visible = samples.filter((sample) => sample.t <= time + 1e-6 && sample.y >= -0.05);
    if (visible.length < 2) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(1.5, 2 * this.dpr);
    ctx.beginPath();
    ctx.moveTo(camera.toX(visible[0].x), camera.toY(visible[0].y));
    for (let i = 1; i < visible.length; i += 1) ctx.lineTo(camera.toX(visible[i].x), camera.toY(visible[i].y));
    ctx.stroke();
    ctx.restore();
  }

  drawTrail(ctx, camera, samples, time) {
    const visible = samples.filter((sample) => sample.t <= time + 1e-6 && sample.y >= -0.05);
    if (visible.length < 2) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(1.25, 1.6 * this.dpr);
    for (let i = 1; i < visible.length; i += 1) {
      const a = visible[i - 1];
      const b = visible[i];
      const fade = i / (visible.length - 1);
      ctx.strokeStyle = `rgba(255,255,255,${(0.08 + fade * 0.55).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(camera.toX(a.x), camera.toY(a.y));
      ctx.lineTo(camera.toX(b.x), camera.toY(b.y));
      ctx.stroke();
    }
    ctx.restore();
  }

  drawPlane(ctx, camera, pose) {
    const x = camera.toX(pose.x);
    const y = camera.toY(pose.y);
    const altitude = Math.max(0, pose.y);
    const shadowScale = 1 / (1 + altitude * 0.45);
    const minPx = this.ambientPlanePx();
    const drawScale = Math.max(camera.scale, (minPx * this.dpr) / 0.22);

    if (!this.ambient) {
      const groundY = this.groundAt(pose.x);
      ctx.save();
      ctx.translate(camera.toX(pose.x), camera.toY(groundY) + 3 * this.dpr);
      ctx.scale(shadowScale, shadowScale * 0.28);
      ctx.fillStyle = "rgba(48, 64, 42, 0.18)";
      ctx.beginPath();
      ctx.ellipse(0, 0, 24 * this.dpr, 10 * this.dpr, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    paintPlaneSprite(ctx, x, y, pose.theta, drawScale * 0.22, this.dpr);
  }

  drawCaption(ctx, width, xPosition, live, windX) {
    const calm = Math.abs(windX) < 0.3;
    const wind = calm
      ? "Calm"
      : `${Math.abs(windX).toFixed(1)} m/s ${windX > 0 ? "tailwind" : "headwind"}`;
    const place = live ? formatMeters(Math.max(0, xPosition)) : "Ready";
    ctx.save();
    ctx.font = `${14 * this.dpr}px "Iowan Old Style", Palatino, Georgia, serif`;
    ctx.fillStyle = "rgba(36, 48, 39, 0.72)";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText(wind, 16 * this.dpr, 14 * this.dpr);
    ctx.textAlign = "right";
    ctx.fillText(place, width - 16 * this.dpr, 14 * this.dpr);
    ctx.restore();
  }
}
