// Paper folding. Each crease is a wrapper; the panels it folds are its children,
// so a turn carries everything stacked on that crease. Shapes come from the
// sliders and the editor. Anime.js v4 only animates the hinge angles.

import { createTimeline } from "/vendor/animejs/bundles/anime.esm.js";
import { SHAPE_LIMITS, defaultShape } from "./plane.js";

const MOVE = 700;
const GAP = 180;
const HOLD = 280;
const WING_LEFT = -26;
const WING_RIGHT = 154;
const KEEL_LEFT = -70;
const KEEL_RIGHT = 70;
const PITCH = 0;
const KEEL_WIDTH = 26;

const STEP_NAMES = [
  "Flat sheet",
  "Center crease",
  "Top corners to the center line",
  "New edges to the center again",
  "Fold in half along the spine",
  "Wings down",
];

function clamp(value, limits, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(limits[1], Math.max(limits[0], n));
}

function normalize(raw) {
  const base = defaultShape();
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    span: clamp(source.span, SHAPE_LIMITS.span, base.span),
    rootChord: clamp(source.rootChord, SHAPE_LIMITS.rootChord, base.rootChord),
    tipChord: clamp(source.tipChord, SHAPE_LIMITS.tipChord, base.tipChord),
    sweepDeg: clamp(source.sweepDeg, SHAPE_LIMITS.sweepDeg, base.sweepDeg),
  };
}

function shapeKey(shape) {
  const next = normalize(shape);
  return `${next.span.toFixed(4)}|${next.rootChord.toFixed(4)}|${next.tipChord.toFixed(4)}|${next.sweepDeg.toFixed(2)}`;
}

function sheetOf(shape) {
  const next = normalize(shape);
  const spanT = (next.span - SHAPE_LIMITS.span[0]) / (SHAPE_LIMITS.span[1] - SHAPE_LIMITS.span[0]);
  const rootT = (next.rootChord - SHAPE_LIMITS.rootChord[0]) / (SHAPE_LIMITS.rootChord[1] - SHAPE_LIMITS.rootChord[0]);
  const half = 84 + spanT * 32;
  const shear = (next.sweepDeg / SHAPE_LIMITS.sweepDeg[1]) * 0.38;
  const y1 = half;
  const y2 = half * Math.tan((67.5 * Math.PI) / 180);
  const wingRoot = 64 + rootT * 56;
  const tipRatio = next.tipChord / next.rootChord;
  const deform = (x, y) => ({ x, y: y + shear * x });
  const top = deform(half, 0);
  const c1 = deform(half, y1);
  const c2 = deform(half, y2);
  const tip = deform(half, y2 + wingRoot * tipRatio);
  const root = deform(0, y2 + wingRoot);
  const tail = Math.max(top.y, c1.y, c2.y, tip.y, root.y);
  return { half, shear, top, c1, c2, tip, root, tail, keel: Math.min(KEEL_WIDTH, half * 0.28) };
}

function node(className) {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

function polyArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function clipX(points, limit, keepGreater) {
  const inside = (p) => (keepGreater ? p.x >= limit - 1e-6 : p.x <= limit + 1e-6);
  const cross = (a, b) => {
    const t = (limit - a.x) / (b.x - a.x || 1e-9);
    return { x: limit, y: a.y + (b.y - a.y) * t };
  };
  const out = [];
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const ain = inside(a);
    const bin = inside(b);
    if (ain && bin) out.push(b);
    else if (ain && !bin) out.push(cross(a, b));
    else if (!ain && bin) {
      out.push(cross(a, b));
      out.push(b);
    }
  }
  return out;
}

function toLocal(angleDeg, point) {
  const r = (-angleDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: point.x * c - point.y * s, y: point.x * s + point.y * c };
}

function addPaper(parent, points, lift) {
  if (points.length < 3 || polyArea(points) < 4) return;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const width = Math.max(1, Math.max(...xs) - minX);
  const height = Math.max(1, Math.max(...ys) - minY);
  const clip = `polygon(${points.map((p) => `${(p.x - minX).toFixed(2)}px ${(p.y - minY).toFixed(2)}px`).join(",")})`;
  for (const side of ["front", "back"]) {
    const face = node(`paper ${side}`);
    face.style.left = `${minX}px`;
    face.style.top = `${minY}px`;
    face.style.width = `${width}px`;
    face.style.height = `${height}px`;
    face.style.clipPath = clip;
    face.style.transform = side === "front" ? `translateZ(${lift}px)` : `rotateY(180deg) translateZ(${lift}px)`;
    parent.append(face);
  }
}

function addCrease(parent, axis, length, at) {
  const line = node(axis === "x" ? "crease along-x" : "crease along-y");
  if (axis === "x") {
    line.style.left = "0px";
    line.style.top = `${at}px`;
    line.style.width = `${Math.max(1, length)}px`;
  } else {
    line.style.left = `${at}px`;
    line.style.top = "0px";
    line.style.height = `${Math.max(1, length)}px`;
  }
  parent.append(line);
}

function buildHalf(sheet) {
  const { half, top, c1, c2, tip, root, tail, keel } = sheet;
  const cornerAngle = (Math.atan2(c1.y, c1.x) * 180) / Math.PI;
  const edgeAngle = (Math.atan2(c2.y, c2.x) * 180) / Math.PI;
  const wing = [ { x: 0, y: 0 }, c2, tip, root ];
  const keelPoly = clipX(wing, keel, false);
  const wingPoly = clipX(wing, keel, true).map((p) => ({ x: p.x - keel, y: p.y }));

  const spine = node("d3 hinge spine");
  spine.style.transformOrigin = "0px 0px";
  spine.style.height = `${tail}px`;

  const keelHinge = node("d3 hinge keel");
  keelHinge.style.width = `${keel}px`;
  keelHinge.style.height = `${tail}px`;
  keelHinge.style.transformOrigin = `${keel}px 0px`;
  addPaper(keelHinge, keelPoly, 1.5);
  addCrease(keelHinge, "y", tail, keel);

  const edgeLift = node("d3");
  edgeLift.style.transform = "translateZ(2px)";
  const edgeMount = node("d3 mount");
  edgeMount.style.transform = `rotateZ(${edgeAngle}deg)`;
  edgeMount.style.transformOrigin = "0px 0px";
  const edgeHinge = node("d3 hinge edge");
  edgeHinge.style.transformOrigin = "0px 0px";
  const edgeLocal = [ { x: 0, y: 0 }, c1, c2 ].map((p) => toLocal(edgeAngle, p));
  addPaper(edgeHinge, edgeLocal, 1.5);
  addCrease(edgeHinge, "x", Math.hypot(c2.x, c2.y), 0);

  const cornerLift = node("d3");
  cornerLift.style.transform = "translateZ(2px)";
  const cornerMount = node("d3 mount");
  cornerMount.style.transform = `rotateZ(${cornerAngle - edgeAngle}deg)`;
  cornerMount.style.transformOrigin = "0px 0px";
  const cornerHinge = node("d3 hinge corner");
  cornerHinge.style.transformOrigin = "0px 0px";
  const cornerLocal = [ { x: 0, y: 0 }, top, c1 ].map((p) => toLocal(cornerAngle, p));
  addPaper(cornerHinge, cornerLocal, 1.5);
  addCrease(cornerHinge, "x", Math.hypot(c1.x, c1.y), 0);
  cornerMount.append(cornerHinge);
  cornerLift.append(cornerMount);
  edgeHinge.append(cornerLift);
  edgeMount.append(edgeHinge);
  edgeLift.append(edgeMount);
  keelHinge.append(edgeLift);

  const wingHinge = node("d3 hinge wing");
  wingHinge.style.left = `${keel}px`;
  wingHinge.style.width = `${Math.max(1, half - keel)}px`;
  wingHinge.style.height = `${tail}px`;
  wingHinge.style.transformOrigin = "0px 0px";
  const wingLift = node("d3");
  wingLift.style.transform = "translateZ(2px)";
  addPaper(wingLift, wingPoly, 1.5);
  const wingTop = Math.min(...wingPoly.map((p) => p.y));
  const wingBottom = Math.max(...wingPoly.map((p) => p.y));
  addCrease(wingLift, "y", wingBottom - wingTop, 0);
  const crease = wingLift.querySelector(".crease");
  if (crease) crease.style.top = `${wingTop}px`;
  wingHinge.append(wingLift);

  spine.append(keelHinge, wingHinge);
  return spine;
}

function buildModel(stage, shape) {
  const sheet = sheetOf(shape);
  const shift = node("fold-shift");
  const camera = node("fold-camera");
  const model = node("fold-model");
  const hover = node("fold-hover");

  const pitch = node("d3 fold-pitch");
  pitch.style.transformOrigin = "0px 0px";
  const shadowSlot = node("fold-shadow-slot");
  const shadow = node("fold-shadow");
  const shadowW = sheet.half * 2.3;
  const shadowH = Math.max(36, sheet.tail * 0.22);
  shadow.style.width = `${shadowW}px`;
  shadow.style.height = `${shadowH}px`;
  shadow.style.marginLeft = `${-shadowW / 2}px`;
  shadow.style.marginTop = `${-shadowH / 2}px`;
  shadowSlot.append(shadow);

  const left = node("d3 mirror");
  left.style.top = `${-sheet.tail / 2}px`;
  left.style.transform = "scaleX(-1) translateZ(0px)";
  left.style.transformOrigin = "0px 0px";
  const leftHalf = buildHalf(sheet);
  leftHalf.classList.add("left");
  left.append(leftHalf);

  const right = node("d3");
  right.style.top = `${-sheet.tail / 2}px`;
  right.style.transform = "translateZ(-2px)";
  const rightHalf = buildHalf(sheet);
  rightHalf.classList.add("right");
  right.append(rightHalf);

  pitch.append(left, right);
  hover.append(pitch);
  model.append(shadowSlot, hover);
  camera.append(model);
  shift.append(camera);
  stage.replaceChildren(shift);

  return {
    shift,
    hover,
    pitch,
    shadow,
    spine: rightHalf,
    corners: stage.querySelectorAll(".corner"),
    edges: stage.querySelectorAll(".edge"),
    wingL: leftHalf.querySelector(".wing"),
    wingR: rightHalf.querySelector(".wing"),
    keelL: leftHalf.querySelector(".keel"),
    keelR: rightHalf.querySelector(".keel"),
  };
}

function poses() {
  const flat = { spine: 0, corner: 0, edge: 0, wingL: 0, wingR: 0, keelL: 0, keelR: 0, pitch: 0 };
  const folded = { ...flat, spine: -180, corner: -180, edge: -180 };
  return [
    flat,
    { ...flat, spine: -90 },
    { ...flat, spine: -180 },
    { ...flat, corner: -90 },
    { ...flat, corner: -180 },
    { ...flat, corner: -180, edge: -90 },
    { ...flat, corner: -180, edge: -180 },
    { ...flat, spine: -90, corner: -180, edge: -180 },
    folded,
    { ...folded, pitch: PITCH / 2, wingL: WING_LEFT / 2, wingR: WING_RIGHT / 2, keelL: KEEL_LEFT / 2, keelR: KEEL_RIGHT / 2 },
    { ...folded, pitch: PITCH, wingL: WING_LEFT, wingR: WING_RIGHT, keelL: KEEL_LEFT, keelR: KEEL_RIGHT },
  ];
}

function applyPose(rig, pose) {
  rig.spine.style.transform = `rotateY(${pose.spine}deg)`;
  for (const el of rig.corners) el.style.transform = `rotateX(${pose.corner}deg)`;
  for (const el of rig.edges) el.style.transform = `rotateX(${pose.edge}deg)`;
  rig.wingL.style.transform = `rotateY(${pose.wingL}deg)`;
  rig.wingR.style.transform = `rotateY(${pose.wingR}deg)`;
  rig.keelL.style.transform = `rotateY(${pose.keelL}deg)`;
  rig.keelR.style.transform = `rotateY(${pose.keelR}deg)`;
  rig.pitch.style.transform = `rotateX(${pose.pitch}deg)`;
}

function clearPose(rig) {
  applyPose(rig, poses()[0]);
  rig.spine.style.transform = "";
  for (const el of rig.corners) el.style.transform = "";
  for (const el of rig.edges) el.style.transform = "";
  rig.wingL.style.transform = "";
  rig.wingR.style.transform = "";
  rig.keelL.style.transform = "";
  rig.keelR.style.transform = "";
  rig.pitch.style.transform = "";
}

function measure(stage) {
  const panels = stage.querySelectorAll(".paper, .crease, .fold-shadow");
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of panels) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    minX = Math.min(minX, rect.left);
    minY = Math.min(minY, rect.top);
    maxX = Math.max(maxX, rect.right);
    maxY = Math.max(maxY, rect.bottom);
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

function fit(stage, rig) {
  const pad = 36;
  const bounds = stage.getBoundingClientRect();
  rig.shift.style.transform = "scale(1) translate(0px, 0px)";
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pose of poses()) {
    applyPose(rig, pose);
    const box = measure(stage);
    if (!box) continue;
    minX = Math.min(minX, box.minX);
    minY = Math.min(minY, box.minY);
    maxX = Math.max(maxX, box.maxX);
    maxY = Math.max(maxY, box.maxY);
  }
  clearPose(rig);
  if (!Number.isFinite(minX)) return;
  const originX = bounds.left + bounds.width / 2;
  const originY = bounds.top + bounds.height * 0.48;
  const dx = originX - (minX + maxX) / 2;
  const dy = originY - (minY + maxY) / 2;
  const scale = Math.max(0.25, Math.min((bounds.width - pad * 2) / (maxX - minX), (bounds.height - pad * 2) / (maxY - minY)));
  rig.shift.style.transform = `scale(${scale}) translate(${dx}px, ${dy}px)`;

  // Perspective makes the scale a little nonlinear, so measure once more and shrink if needed.
  let overflow = 1;
  for (const pose of poses()) {
    applyPose(rig, pose);
    const box = measure(stage);
    if (!box) continue;
    const fitW = (bounds.width - pad * 2) / box.w;
    const fitH = (bounds.height - pad * 2) / box.h;
    overflow = Math.min(overflow, fitW, fitH);
  }
  clearPose(rig);
  if (overflow < 0.98) {
    rig.shift.style.transform = `scale(${scale * overflow}) translate(${dx}px, ${dy}px)`;
  }
}

function stepIndex(marks, time) {
  let index = 0;
  for (let i = 0; i < marks.length; i += 1) {
    if (time + 1 >= marks[i]) index = i;
  }
  return index;
}

function initFold(container, getShape) {
  const stage = container?.querySelector(".fold-stage");
  const caption = container?.querySelector(".fold-caption");
  const scrub = container?.querySelector("[data-fold='scrub']");
  const play = container?.querySelector("[data-fold='play']");
  const replay = container?.querySelector("[data-fold='replay']");
  if (!stage || !caption || !scrub || !play || !replay) return;

  let timeline = null;
  let rig = null;
  let marks = [0];
  let key = "";
  let wait = 0;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function stopIdle() {
    rig?.hover.classList.remove("idle");
    rig?.shadow.classList.remove("idle");
  }

  function startIdle() {
    rig?.hover.classList.add("idle");
    rig?.shadow.classList.add("idle");
  }

  function sync(time) {
    scrub.value = String(Math.round(time));
    caption.textContent = STEP_NAMES[stepIndex(marks, time)];
  }

  function build(playFromStart) {
    if (timeline) timeline.pause();
    timeline = null;
    stopIdle();
    const shape = getShape();
    key = shapeKey(shape);
    rig = buildModel(stage, shape);
    fit(stage, rig);

    const tl = createTimeline({
      autoplay: false,
      defaults: { ease: "inOutCubic", duration: MOVE },
      onUpdate(self) {
        sync(self.currentTime);
        if (self.currentTime < self.duration - 30) stopIdle();
      },
      onComplete() {
        sync(tl.duration);
        startIdle();
      },
    });

    tl.set(rig.spine, { rotateY: 0 }, 0);
    tl.set(rig.corners, { rotateX: 0 }, 0);
    tl.set(rig.edges, { rotateX: 0 }, 0);
    tl.set(rig.wingL, { rotateY: 0 }, 0);
    tl.set(rig.wingR, { rotateY: 0 }, 0);
    tl.set(rig.keelL, { rotateY: 0 }, 0);
    tl.set(rig.keelR, { rotateY: 0 }, 0);
    tl.set(rig.pitch, { rotateX: 0 }, 0);
    tl.set(rig.shadow, { scale: 1 }, 0);

    let t = HOLD;
    const started = [0];
    started.push(t);
    tl.add(rig.spine, { rotateY: -180 }, t);
    t += MOVE;
    tl.add(rig.spine, { rotateY: 0 }, t);
    t += MOVE + GAP;

    started.push(t);
    tl.add(rig.corners, { rotateX: -180 }, t);
    t += MOVE + GAP;

    started.push(t);
    tl.add(rig.edges, { rotateX: -180 }, t);
    t += MOVE + GAP;

    started.push(t);
    tl.add(rig.spine, { rotateY: -180 }, t);
    t += MOVE + GAP;

    started.push(t);
    tl.add(rig.wingL, { rotateY: WING_LEFT }, t);
    tl.add(rig.wingR, { rotateY: WING_RIGHT }, t);
    tl.add(rig.keelL, { rotateY: KEEL_LEFT }, t);
    tl.add(rig.keelR, { rotateY: KEEL_RIGHT }, t);
    tl.add(rig.pitch, { rotateX: PITCH }, t);
    tl.add(rig.shadow, { scale: 0.66 }, t);

    marks = started;
    timeline = tl;
    scrub.max = String(Math.ceil(tl.duration));
    tl.seek(0);
    sync(0);

    if (reduced) {
      tl.seek(tl.duration);
      sync(tl.duration);
      return;
    }
    if (playFromStart) tl.play();
  }

  play.addEventListener("click", () => {
    if (!timeline) return;
    stopIdle();
    if (timeline.completed || timeline.currentTime >= timeline.duration - 1) timeline.restart();
    else timeline.play();
  });

  replay.addEventListener("click", () => {
    if (!timeline) return;
    stopIdle();
    timeline.restart();
  });

  scrub.addEventListener("input", () => {
    if (!timeline) return;
    stopIdle();
    timeline.pause();
    timeline.seek(Number(scrub.value));
    sync(timeline.currentTime);
    if (timeline.currentTime >= timeline.duration - 1) startIdle();
  });

  const observer = new ResizeObserver(() => {
    if (!rig || !timeline) return;
    const time = timeline.currentTime;
    const wasPlaying = !timeline.paused;
    timeline.pause();
    fit(stage, rig);
    timeline.seek(time);
    if (wasPlaying) timeline.play();
  });
  observer.observe(stage);

  window.setInterval(() => {
    const next = shapeKey(getShape());
    if (next === key) return;
    window.clearTimeout(wait);
    wait = window.setTimeout(() => build(true), 280);
  }, 200);

  build(false);
}

export { initFold };
