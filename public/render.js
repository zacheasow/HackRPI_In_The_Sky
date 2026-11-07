/**
 * Side-view flight canvas: sky, ground, trajectory, and the paper airplane.
 */

import { windVelocity } from "./physics.js";

const PAPER = "#f7f4ee";
const INK = "#1d4e73";
const TRAIL = "#ffffff";
const TRAIL_SHADOW = "#e07a3d";

function lerp(a, b, t) {
  return a + (b - a) * t;
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

export class FlightView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.raf = 0;
    this.loopId = 0;
    this.dpr = 1;
    this.scene = null;
    this.onProgress = null;

    this.resize = this.resize.bind(this);
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(canvas);
    window.addEventListener("resize", this.resize);
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
    const idleAlready = this.scene && !this.scene.live;
    if (!idleAlready) this.stop();
    const time = idleAlready ? this.scene.time : 0;
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
    if (nextWind.mode === "off") {
      if (idleAlready) this.stop();
      this.redraw();
      return;
    }
    this.redraw();
    if (!this.raf) {
      const started = performance.now() - time * 1000;
      this.beginLoop((now) => {
        if (!this.scene || this.scene.live) return false;
        this.scene.time = (now - started) / 1000;
        this.redraw();
        return true;
      });
    }
  }

  play(result, onProgress) {
    this.stop();
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

  redraw() {
    if (!this.scene || !this.ctx) return;
    const ctx = this.ctx;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const pose = sampleAt(this.scene.samples, this.scene.time) || this.scene.samples[0];
    const bounds = this.boundsFor(this.scene, pose);

    ctx.clearRect(0, 0, width, height);
    this.drawSky(ctx, width, height);
    const wind = this.scene.wind || { mode: "off", steady: 0, phases: [0, 0, 0, 0] };
    const velocity = windVelocity(wind, this.scene.time || 0);
    this.drawWindStreaks(ctx, width, height, velocity, this.scene.time || 0);
    const camera = this.camera(bounds, width, height);
    this.drawGround(ctx, camera, bounds);
    this.drawTrail(ctx, camera, this.scene.samples, this.scene.time);
    if (pose) this.drawPlane(ctx, camera, pose, this.scene.bodyLength);
    this.drawBadge(ctx, width, pose ? pose.x : 0, this.scene.live);
    this.drawWindLabel(ctx, velocity.x);
  }

  drawWindStreaks(ctx, width, height, velocity, time) {
    const speed = Math.hypot(velocity.x, velocity.y);
    if (speed < 0.05) return;
    const dx = velocity.x / speed;
    const dy = -velocity.y / speed;
    const opacity = Math.min(0.85, 0.16 + speed * 0.16);
    const length = (8 + speed * 14) * this.dpr;
    const travel = time * (22 + speed * 26) * this.dpr;
    const skyBottom = height * 0.78;

    ctx.save();
    ctx.strokeStyle = `rgba(255,255,255,${opacity.toFixed(3)})`;
    ctx.lineWidth = Math.max(1, 1.4 * this.dpr);
    ctx.lineCap = "round";
    const cols = 6;
    const rows = 4;
    for (let i = 0; i < cols; i += 1) {
      for (let j = 0; j < rows; j += 1) {
        const originX = ((i + 0.25) / cols) * width;
        const originY = ((j + 0.4) / rows) * skyBottom;
        const xPeriod = width + length;
        const yPeriod = skyBottom + length;
        let x = originX + dx * travel;
        let y = originY + dy * travel;
        x = ((x % xPeriod) + xPeriod) % xPeriod - length * 0.5;
        y = ((y % yPeriod) + yPeriod) % yPeriod;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - dx * length, y - dy * length);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawWindLabel(ctx, windX) {
    const calm = Math.abs(windX) < 0.3;
    const text = calm
      ? "Wind: calm"
      : `Wind: ${Math.abs(windX).toFixed(1)} m/s ${windX > 0 ? "tailwind" : "headwind"}`;
    const dir = calm ? 0 : Math.sign(windX);
    const arrow = 16 * this.dpr;
    ctx.save();
    ctx.font = `600 ${15 * this.dpr}px "Segoe UI", sans-serif`;
    const padX = 14 * this.dpr;
    const textW = ctx.measureText(text).width;
    const boxW = textW + padX * 2 + (dir ? arrow : 0);
    const boxH = 34 * this.dpr;
    const x = 16 * this.dpr;
    const y = 16 * this.dpr;
    ctx.fillStyle = "rgba(255,255,255,0.82)";
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = this.dpr;
    this.roundRect(ctx, x, y, boxW, boxH, 12 * this.dpr);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.6 * this.dpr;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    let textX = x + padX;
    if (dir) {
      const ax = x + padX + arrow * 0.45;
      const ay = y + boxH / 2;
      ctx.beginPath();
      ctx.moveTo(ax - dir * arrow * 0.35, ay);
      ctx.lineTo(ax + dir * arrow * 0.4, ay);
      ctx.moveTo(ax + dir * arrow * 0.1, ay - arrow * 0.28);
      ctx.lineTo(ax + dir * arrow * 0.4, ay);
      ctx.lineTo(ax + dir * arrow * 0.1, ay + arrow * 0.28);
      ctx.stroke();
      textX += arrow;
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, textX, y + boxH / 2 + this.dpr);
    ctx.restore();
  }

  boundsFor(scene, pose) {
    let minX = -0.6;
    let maxX = 6;
    let maxY = 2.2;
    const future = scene.live ? scene.samples : [pose];
    for (const sample of future) {
      if (!sample) continue;
      minX = Math.min(minX, sample.x);
      maxX = Math.max(maxX, sample.x);
      maxY = Math.max(maxY, sample.y);
    }
    if (pose) maxY = Math.max(maxY, pose.y);
    return {
      minX: minX - 0.4,
      maxX: maxX + Math.max(0.8, maxX * 0.04),
      maxY: maxY + 0.35,
    };
  }

  camera(bounds, width, height) {
    const worldW = Math.max(1, bounds.maxX - bounds.minX);
    const groundBand = Math.max(height * 0.16, 48 * this.dpr);
    const topPad = height * 0.08;
    const sidePad = width * 0.05;
    const scaleX = (width - sidePad * 2) / worldW;
    const scaleY = (height - groundBand - topPad) / Math.max(bounds.maxY, 0.5);
    const scale = Math.max(1, Math.min(scaleX, scaleY));
    const offsetX = sidePad - bounds.minX * scale;
    const offsetY = height - groundBand;
    return {
      scale,
      toX: (x) => offsetX + x * scale,
      toY: (y) => offsetY - y * scale,
    };
  }

  drawSky(ctx, width, height) {
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, "#6eb6e4");
    sky.addColorStop(0.55, "#b7def5");
    sky.addColorStop(1, "#e7f5fb");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.globalAlpha = 0.55;
    const clouds = [
      [0.18, 0.22, 0.16],
      [0.62, 0.16, 0.2],
      [0.84, 0.3, 0.12],
      [0.4, 0.38, 0.1],
    ];
    for (const [cx, cy, r] of clouds) {
      this.puff(ctx, cx * width, cy * height, r * width);
    }
    ctx.restore();
  }

  puff(ctx, x, y, radius) {
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath();
    ctx.ellipse(x, y, radius, radius * 0.62, 0, 0, Math.PI * 2);
    ctx.ellipse(x - radius * 0.45, y + radius * 0.08, radius * 0.62, radius * 0.42, 0, 0, Math.PI * 2);
    ctx.ellipse(x + radius * 0.48, y + radius * 0.06, radius * 0.55, radius * 0.38, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  drawGround(ctx, camera, bounds) {
    const y0 = camera.toY(0);
    const bottom = this.canvas.height;
    const width = this.canvas.width;

    const ground = ctx.createLinearGradient(0, y0, 0, bottom);
    ground.addColorStop(0, "#b7d89a");
    ground.addColorStop(0.4, "#7eae62");
    ground.addColorStop(1, "#5d8d49");
    ctx.fillStyle = ground;
    ctx.fillRect(0, y0, width, Math.max(0, bottom - y0));

    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = Math.max(2, this.dpr);
    ctx.beginPath();
    ctx.moveTo(0, y0);
    ctx.lineTo(width, y0);
    ctx.stroke();

    ctx.fillStyle = "rgba(29, 78, 115, 0.55)";
    ctx.font = `${12 * this.dpr}px "Segoe UI", sans-serif`;
    ctx.textAlign = "center";
    const span = bounds.maxX - bounds.minX;
    const step = span > 40 ? 5 : span > 20 ? 2 : 1;
    const start = Math.ceil(bounds.minX / step) * step;
    for (let meter = start; meter <= bounds.maxX; meter += step) {
      const x = camera.toX(meter);
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y0 + 8 * this.dpr);
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.stroke();
      if (meter > 0) ctx.fillText(String(meter), x, y0 + 22 * this.dpr);
    }
  }

  drawTrail(ctx, camera, samples, time) {
    const visible = samples.filter((sample) => sample.t <= time + 1e-6 && sample.y >= -0.05);
    if (visible.length < 2) return;

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 5 * this.dpr;
    ctx.strokeStyle = TRAIL_SHADOW;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    visible.forEach((sample, index) => {
      const x = camera.toX(sample.x);
      const y = camera.toY(sample.y);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.globalAlpha = 0.95;
    ctx.lineWidth = 2.5 * this.dpr;
    ctx.strokeStyle = TRAIL;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  drawPlane(ctx, camera, pose, bodyLength) {
    const x = camera.toX(pose.x);
    const y = camera.toY(pose.y);
    const altitude = Math.max(0, pose.y);
    const shadowScale = 1 / (1 + altitude * 0.35);

    ctx.save();
    ctx.translate(camera.toX(pose.x), camera.toY(0) + 2 * this.dpr);
    ctx.scale(shadowScale, shadowScale * 0.35);
    ctx.fillStyle = "rgba(40, 70, 50, 0.22)";
    ctx.beginPath();
    ctx.ellipse(0, 0, 28 * this.dpr, 10 * this.dpr, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const minPixels = 64 * this.dpr;
    const natural = Math.max(bodyLength, 0.2) * camera.scale;
    const pxPerMeter = Math.max(camera.scale, minPixels / Math.max(bodyLength, 0.2));
    // Keep the airplane readable without stretching a short hop to fill the sky.
    const drawScale = natural < minPixels ? pxPerMeter : camera.scale;

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(drawScale, -drawScale);
    ctx.rotate(pose.theta);
    ctx.lineJoin = "round";
    ctx.lineWidth = 1.5 / drawScale;

    ctx.beginPath();
    ctx.moveTo(0.17, 0);
    ctx.lineTo(0.03, 0.014);
    ctx.lineTo(-0.05, 0.02);
    ctx.lineTo(-0.13, 0.062);
    ctx.lineTo(-0.155, 0.02);
    ctx.lineTo(-0.09, 0.01);
    ctx.lineTo(-0.02, -0.016);
    ctx.closePath();
    ctx.fillStyle = PAPER;
    ctx.strokeStyle = "rgba(29, 78, 115, 0.45)";
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0.12, 0.002);
    ctx.lineTo(-0.08, 0.008);
    ctx.strokeStyle = "rgba(29, 78, 115, 0.25)";
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0.16, 0);
    ctx.lineTo(0.1, 0);
    ctx.strokeStyle = "#e07a3d";
    ctx.lineWidth = 2.2 / drawScale;
    ctx.stroke();
    ctx.restore();
  }

  drawBadge(ctx, width, xPosition, live) {
    const label = live ? formatMeters(xPosition) : "Ready";
    ctx.save();
    ctx.font = `600 ${16 * this.dpr}px "Segoe UI", sans-serif`;
    const padX = 14 * this.dpr;
    const textW = ctx.measureText(label).width;
    const boxW = textW + padX * 2;
    const boxH = 34 * this.dpr;
    const x = width - boxW - 16 * this.dpr;
    const y = 16 * this.dpr;
    ctx.fillStyle = "rgba(255,255,255,0.82)";
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = this.dpr;
    this.roundRect(ctx, x, y, boxW, boxH, 12 * this.dpr);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + padX, y + boxH / 2 + this.dpr);
    ctx.restore();
  }

  roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
