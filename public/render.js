/**
 * Side-view flight canvas: sky, ground, trajectory, and the paper airplane.
 */

import { windVelocity } from "./physics.js";

const PAPER = "#f7f4ee";

// Three parallax layers. Far is smaller and fainter; each cloud is several overlapping puffs.
const CLOUD_LAYERS = [
  {
    speed: 8,
    alpha: 0.34,
    scale: 0.5,
    y: 0.13,
    clouds: [0.08, 0.42, 0.78],
  },
  {
    speed: 16,
    alpha: 0.55,
    scale: 0.82,
    y: 0.24,
    clouds: [0.18, 0.55, 0.88],
  },
  {
    speed: 28,
    alpha: 0.72,
    scale: 1.15,
    y: 0.36,
    clouds: [0.05, 0.36, 0.7],
  },
];

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
    this.viewX = null;
    this.viewY = null;
    this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

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
        if (!this.scene || this.scene.live) return false;
        this.scene.time = (now - started) / 1000;
        this.redraw();
        return true;
      });
    }
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

  redraw() {
    if (!this.scene || !this.ctx) return;
    const ctx = this.ctx;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const pose = sampleAt(this.scene.samples, this.scene.time) || this.scene.samples[0];
    const bounds = this.followBounds(pose);
    const driftTime = this.reduced.matches ? 0 : this.scene.time || 0;

    ctx.clearRect(0, 0, width, height);
    this.drawSky(ctx, width, height, driftTime);
    const wind = this.scene.wind || { mode: "off", steady: 0, phases: [0, 0, 0, 0] };
    const velocity = windVelocity(wind, this.scene.time || 0);
    this.drawWindStreaks(ctx, width, height, velocity, driftTime);
    const camera = this.camera(bounds, width, height);
    this.drawGround(ctx, camera, bounds);
    this.drawTrail(ctx, camera, this.scene.samples, this.scene.time);
    if (pose) this.drawPlane(ctx, camera, pose, this.scene.bodyLength);
    this.drawCaption(ctx, width, pose ? pose.x : 0, this.scene.live, velocity.x);
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

  drawSky(ctx, width, height, time) {
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

    for (const layer of CLOUD_LAYERS) {
      const drift = (time * layer.speed * this.dpr) % (width + 1);
      for (const origin of layer.clouds) {
        const x = ((origin * width - drift) % width + width) % width;
        this.drawCloud(ctx, x, height * layer.y, layer.scale, layer.alpha);
        this.drawCloud(ctx, x - width, height * layer.y, layer.scale, layer.alpha);
      }
    }
  }

  drawCloud(ctx, x, y, scale, alpha) {
    const d = this.dpr * scale;
    const blobs = [
      [0, 10, 78, 26, "rgba(186, 198, 206, 0.45)"],
      [-48, 2, 42, 24, "rgba(255,255,255,0.72)"],
      [6, -8, 58, 28, "rgba(255,255,255,0.88)"],
      [52, 0, 36, 20, "rgba(255,255,255,0.7)"],
      [24, 8, 50, 18, "rgba(214, 224, 230, 0.4)"],
    ];
    ctx.save();
    ctx.translate(x, y);
    ctx.filter = `blur(${5 * this.dpr}px)`;
    ctx.globalAlpha = alpha;
    for (const [bx, by, rx, ry, fill] of blobs) {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.ellipse(bx * d, by * d, rx * d, ry * d, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
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

  drawGround(ctx, camera, bounds) {
    const width = this.canvas.width;
    const height = this.canvas.height;
    const hillAt = (worldX) => Math.exp(-((worldX + 0.2) ** 2) / 3.2) * 0.42;

    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let px = 0; px <= width; px += 6) {
      const worldX = (px - camera.offsetX) / camera.scale;
      ctx.lineTo(px, camera.toY(hillAt(worldX)));
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, camera.toY(0.5), 0, height);
    fill.addColorStop(0, "#c5d7a8");
    fill.addColorStop(0.45, "#8eae72");
    fill.addColorStop(1, "#6d8f58");
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.beginPath();
    for (let px = 0; px <= width; px += 6) {
      const worldX = (px - camera.offsetX) / camera.scale;
      const y = camera.toY(hillAt(worldX));
      if (px === 0) ctx.moveTo(px, y);
      else ctx.lineTo(px, y);
    }
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.lineWidth = Math.max(1, this.dpr);
    ctx.stroke();

    ctx.fillStyle = "rgba(36, 48, 39, 0.45)";
    ctx.font = `${12 * this.dpr}px "Iowan Old Style", Palatino, Georgia, serif`;
    ctx.textAlign = "center";
    const start = Math.ceil(bounds.minX);
    for (let meter = start; meter <= bounds.maxX; meter += 1) {
      if (meter <= 0) continue;
      const x = camera.toX(meter);
      const y = camera.toY(hillAt(meter));
      ctx.fillText(String(meter), x, y + 16 * this.dpr);
    }
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
    const drawScale = Math.max(camera.scale, (34 * this.dpr) / 0.22);

    const groundY = Math.exp(-((pose.x + 0.2) ** 2) / 3.2) * 0.42;
    ctx.save();
    ctx.translate(camera.toX(pose.x), camera.toY(groundY) + 3 * this.dpr);
    ctx.scale(shadowScale, shadowScale * 0.28);
    ctx.fillStyle = "rgba(48, 64, 42, 0.18)";
    ctx.beginPath();
    ctx.ellipse(0, 0, 18 * this.dpr, 8 * this.dpr, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(drawScale, -drawScale);
    ctx.rotate(pose.theta);
    ctx.lineJoin = "round";
    ctx.lineWidth = 1.1 / drawScale;
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
    ctx.strokeStyle = "rgba(36, 48, 39, 0.35)";
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0.08, 0.001);
    ctx.lineTo(-0.06, 0.006);
    ctx.strokeStyle = "rgba(36, 48, 39, 0.22)";
    ctx.stroke();
    ctx.restore();
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
