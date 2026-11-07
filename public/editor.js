// Top-down shape editor. Planform math matches plane.js exactly so a handle
// position and its shape value round-trip. x is meters aft of the nose.

import { PAPER, SHAPE_LIMITS, defaultShape, derivePlane } from "./plane.js";

const HANDLES = ["span", "rootChord", "tipChord", "sweep", "tail"];

const HIT_RADIUS = 12;
const HANDLE_RADIUS = 6;
const RULER = 22;

function clamp(value, limits, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(limits[1], Math.max(limits[0], value));
}

function clampShape(shape) {
  const base = defaultShape();
  const source = shape && typeof shape === "object" ? shape : {};
  return {
    span: clamp(source.span, SHAPE_LIMITS.span, base.span),
    rootChord: clamp(source.rootChord, SHAPE_LIMITS.rootChord, base.rootChord),
    tipChord: clamp(source.tipChord, SHAPE_LIMITS.tipChord, base.tipChord),
    sweepDeg: clamp(source.sweepDeg, SHAPE_LIMITS.sweepDeg, base.sweepDeg),
    tailArea: clamp(source.tailArea, SHAPE_LIMITS.tailArea, base.tailArea),
    noseWeight: clamp(source.noseWeight, SHAPE_LIMITS.noseWeight, base.noseWeight),
  };
}

function wingFrame(shape) {
  const half = shape.span / 2;
  const sweep = (shape.sweepDeg * Math.PI) / 180;
  const xQcRoot = PAPER.noseLength + 0.25 * shape.rootChord;
  const xQcTip = xQcRoot + half * Math.tan(sweep);
  return {
    half,
    xLeRoot: PAPER.noseLength,
    xTeRoot: PAPER.noseLength + shape.rootChord,
    xQcTip,
    xLeTip: xQcTip - 0.25 * shape.tipChord,
    xTeTip: xQcTip + 0.75 * shape.tipChord,
  };
}

function tailFrame(shape) {
  const tailSpan = Math.max(PAPER.minTailSpan, PAPER.tailSpanFraction * shape.span);
  const chord = shape.tailArea / tailSpan;
  const xQc = PAPER.noseLength + shape.rootChord + PAPER.tailBoom;
  return {
    tailSpan,
    chord,
    xQc,
    xLe: xQc - 0.25 * chord,
    xTe: xQc + 0.75 * chord,
    y: tailSpan / 2,
  };
}

function handlePosition(shape, handle) {
  const next = clampShape(shape);
  const wing = wingFrame(next);
  const tail = tailFrame(next);
  if (handle === "span") return { x: (wing.xLeTip + wing.xTeTip) / 2, y: wing.half };
  if (handle === "rootChord") return { x: wing.xTeRoot, y: 0 };
  if (handle === "tipChord") return { x: wing.xTeTip, y: wing.half };
  if (handle === "sweep") return { x: wing.xLeTip, y: wing.half };
  if (handle === "tail") return { x: tail.xTe, y: tail.y };
  return null;
}

function shapeFromHandle(shape, handle, point) {
  const next = clampShape(shape);
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (handle === "span") {
    next.span = clamp(Math.abs(y) * 2, SHAPE_LIMITS.span, next.span);
  } else if (handle === "rootChord") {
    next.rootChord = clamp(x - PAPER.noseLength, SHAPE_LIMITS.rootChord, next.rootChord);
  } else if (handle === "tipChord") {
    const wing = wingFrame(next);
    next.tipChord = clamp((x - wing.xQcTip) / 0.75, SHAPE_LIMITS.tipChord, next.tipChord);
  } else if (handle === "sweep") {
    const half = next.span / 2;
    const xQcRoot = PAPER.noseLength + 0.25 * next.rootChord;
    const tanSweep = (x - xQcRoot + 0.25 * next.tipChord) / half;
    const degrees = (Math.atan(tanSweep) * 180) / Math.PI;
    next.sweepDeg = clamp(degrees, SHAPE_LIMITS.sweepDeg, next.sweepDeg);
  } else if (handle === "tail") {
    const tail = tailFrame(next);
    const chord = (x - tail.xQc) / 0.75;
    next.tailArea = clamp(chord * tail.tailSpan, SHAPE_LIMITS.tailArea, next.tailArea);
  }
  return next;
}

function initEditor(canvas, getShape, setShape) {
  const ctx = canvas.getContext("2d");
  let camera = null;
  let drag = null;
  let hover = null;
  let frame = null;

  function shape() {
    return clampShape(getShape());
  }

  function viewSize() {
    return {
      width: canvas.clientWidth || 320,
      height: canvas.clientHeight || 220,
    };
  }

  function limitsBox() {
    // Largest planform the sliders can make. The camera stays on this box
    // so a drag does not zoom out from under the pointer.
    const wide = clampShape({
      span: SHAPE_LIMITS.span[1],
      rootChord: SHAPE_LIMITS.rootChord[1],
      tipChord: SHAPE_LIMITS.tipChord[1],
      sweepDeg: SHAPE_LIMITS.sweepDeg[1],
      tailArea: SHAPE_LIMITS.tailArea[1],
      noseWeight: 0,
    });
    const longTail = clampShape({ ...wide, span: SHAPE_LIMITS.span[0] });
    const wing = wingFrame(wide);
    return {
      minX: Math.min(0, wing.xLeTip),
      maxX: Math.max(derivePlane(wide).bodyLength, derivePlane(longTail).bodyLength, wing.xTeTip),
      minY: -wing.half,
      maxY: wing.half,
    };
  }

  function shapeBox(current) {
    const wing = wingFrame(current);
    const plane = derivePlane(current);
    return {
      minX: Math.min(0, wing.xLeTip),
      maxX: Math.max(plane.bodyLength, wing.xTeTip),
      minY: -wing.half,
      maxY: wing.half,
    };
  }

  function fit(current) {
    const limits = limitsBox();
    const box = frame || shapeBox(current);
    const { width, height } = viewSize();
    const drawH = Math.max(40, height - RULER);
    const limitW = limits.maxX - limits.minX;
    const limitH = limits.maxY - limits.minY;
    const scale = 0.8 * Math.min(width / limitW, drawH / limitH);
    const worldW = box.maxX - box.minX;
    const worldH = box.maxY - box.minY;
    camera = {
      minX: box.minX,
      maxY: box.maxY,
      scale,
      offsetX: (width - worldW * scale) / 2,
      offsetY: RULER + (drawH - worldH * scale) / 2,
    };
  }

  function toScreen(point) {
    return {
      x: camera.offsetX + (point.x - camera.minX) * camera.scale,
      y: camera.offsetY + (camera.maxY - point.y) * camera.scale,
    };
  }

  function toWorld(px, py) {
    return {
      x: camera.minX + (px - camera.offsetX) / camera.scale,
      y: camera.maxY - (py - camera.offsetY) / camera.scale,
    };
  }

  function pointerPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  function handlePoints() {
    const current = shape();
    const wing = wingFrame(current);
    const points = HANDLES.map((id) => ({ id, side: 1, ...handlePosition(current, id) }));
    points.push({
      id: "span",
      side: -1,
      x: (wing.xLeTip + wing.xTeTip) / 2,
      y: -wing.half,
    });
    return points;
  }

  function uiFont(px) {
    const family = getComputedStyle(canvas).fontFamily || "Palatino, Georgia, serif";
    return `${px}px ${family}`;
  }

  function crisp(value, ratio) {
    return Math.round(value * ratio) / ratio;
  }

  function screenOffset(handle, wing) {
    if (handle.id !== "span" && handle.id !== "sweep" && handle.id !== "tipChord") return { x: 0, y: 0 };
    const sign = handle.y >= 0 ? 1 : -1;
    const tipLe = toScreen({ x: wing.xLeTip, y: sign * wing.half });
    const tipTe = toScreen({ x: wing.xTeTip, y: sign * wing.half });
    const len = Math.hypot(tipTe.x - tipLe.x, tipTe.y - tipLe.y) || 1;
    const ux = (tipTe.x - tipLe.x) / len;
    const uy = (tipTe.y - tipLe.y) / len;
    let px = -uy;
    let py = ux;
    const center = toScreen({ x: 0, y: 0 });
    const midX = (tipLe.x + tipTe.x) / 2 - center.x;
    const midY = (tipLe.y + tipTe.y) / 2 - center.y;
    if (midX * px + midY * py < 0) {
      px = -px;
      py = -py;
    }
    const out = 10;
    const along = 16;
    if (handle.id === "span") return { x: px * out, y: py * out };
    if (handle.id === "sweep") return { x: px * out - ux * along, y: py * out - uy * along };
    return { x: px * out + ux * along, y: py * out + uy * along };
  }

  function placeHandle(handle, wing) {
    const screen = toScreen(handle);
    const frozen = drag && drag.id === handle.id && drag.side === handle.side;
    const off = frozen ? { x: drag.ox, y: drag.oy } : screenOffset(handle, wing);
    return { x: screen.x + off.x, y: screen.y + off.y, ox: off.x, oy: off.y };
  }

  function hitHandle(px, py) {
    const wing = wingFrame(shape());
    let best = null;
    let bestDistance = HIT_RADIUS;
    for (const handle of handlePoints()) {
      const place = placeHandle(handle, wing);
      const distance = Math.hypot(place.x - px, place.y - py);
      if (distance <= bestDistance) {
        best = { ...handle, ox: place.ox, oy: place.oy };
        bestDistance = distance;
      }
    }
    return best;
  }

  function draw() {
    const current = shape();
    const wing = wingFrame(current);
    const tail = tailFrame(current);
    const plane = derivePlane(current);
    const { width, height } = viewSize();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    fit(current);

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#f6f1e8";
    ctx.fillRect(0, 0, width, RULER);
    drawGrid(width, height, ratio);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER, width, height - RULER);
    ctx.clip();
    drawPlanform(wing, tail, plane, current);
    drawBalance(plane, wing, height);
    for (const handle of handlePoints()) {
      const hot = (item) => item && item.id === handle.id && item.side === handle.side;
      drawHandle(placeHandle(handle, wing), hot(drag) || hot(hover));
    }
    if (drag) drawTooltip(tipText(drag.id, current), placeHandle(drag, wing), width, height);
    ctx.restore();
    drawRuler(width, ratio);
  }

  function drawPlanform(wing, tail, plane, current) {
    const outline = [
      { x: wing.xLeTip, y: -wing.half },
      { x: wing.xLeRoot, y: 0 },
      { x: wing.xLeTip, y: wing.half },
      { x: wing.xTeTip, y: wing.half },
      { x: wing.xTeRoot, y: 0 },
      { x: wing.xTeTip, y: -wing.half },
    ].map(toScreen);
    ctx.beginPath();
    outline.forEach((point, index) => (index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
    ctx.closePath();
    ctx.fillStyle = "#fbf8f2";
    ctx.strokeStyle = "#243027";
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();

    const tailPoly = [
      { x: tail.xLe, y: -tail.y },
      { x: tail.xLe, y: tail.y },
      { x: tail.xTe, y: tail.y },
      { x: tail.xTe, y: -tail.y },
    ].map(toScreen);
    ctx.beginPath();
    tailPoly.forEach((point, index) => (index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    const nose = toScreen({ x: 0, y: 0 });
    const stern = toScreen({ x: plane.bodyLength, y: 0 });
    ctx.beginPath();
    ctx.moveTo(nose.x, nose.y);
    ctx.lineTo(stern.x, stern.y);
    ctx.strokeStyle = "#243027";
    ctx.lineWidth = Math.max(2, PAPER.fuselageWidth * camera.scale);
    ctx.lineCap = "round";
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(nose.x, nose.y, 3.5 + current.noseWeight * 0.7, 0, Math.PI * 2);
    ctx.fillStyle = "#d2652d";
    ctx.fill();
  }

  function drawGrid(width, height, ratio) {
    const xAt = (px) => camera.minX + (px - camera.offsetX) / camera.scale;
    const yAt = (py) => camera.maxY - (py - camera.offsetY) / camera.scale;
    const x0 = xAt(0);
    const x1 = xAt(width);
    const y0 = yAt(height);
    const y1 = yAt(RULER);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER, width, height - RULER);
    ctx.clip();
    ctx.lineWidth = 1;
    const strokeRow = (cm, horizontal) => {
      const major = cm % 10 === 0;
      ctx.strokeStyle = major ? "rgba(36, 48, 39, 0.12)" : "rgba(36, 48, 39, 0.04)";
      ctx.beginPath();
      if (horizontal) {
        const y = crisp(toScreen({ x: 0, y: cm / 100 }).y, ratio);
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      } else {
        const x = crisp(toScreen({ x: cm / 100, y: 0 }).x, ratio);
        ctx.moveTo(x, RULER);
        ctx.lineTo(x, height);
      }
      ctx.stroke();
    };
    for (let cm = Math.ceil(y0 * 20) * 5; cm <= y1 * 100; cm += 5) strokeRow(cm, true);
    for (let cm = Math.ceil(x0 * 20) * 5; cm <= x1 * 100; cm += 5) strokeRow(cm, false);
    ctx.restore();
  }

  function drawRuler(width, ratio) {
    const xAt = (px) => camera.minX + (px - camera.offsetX) / camera.scale;
    const pxPerCm = camera.scale / 100;
    const steps = [1, 2, 5, 10, 20, 50];
    const step = steps.find((item) => item * pxPerCm >= 36) || 50;
    const minor = step / 2;
    const x0 = xAt(0) * 100;
    const x1 = xAt(width) * 100;
    ctx.strokeStyle = "rgba(36, 48, 39, 0.28)";
    ctx.lineWidth = 1;
    ctx.font = uiFont(12);
    ctx.fillStyle = "#5c6b60";
    ctx.textBaseline = "top";
    const labels = [];
    for (let cm = Math.ceil(x0 / minor) * minor; cm <= x1 + 1e-6; cm += minor) {
      const x = crisp(toScreen({ x: cm / 100, y: 0 }).x, ratio);
      const major = Math.abs(cm / step - Math.round(cm / step)) < 1e-6;
      ctx.beginPath();
      ctx.moveTo(x, RULER - 1);
      ctx.lineTo(x, RULER - (major ? 9 : 5));
      ctx.stroke();
      if (major && cm >= -1e-6) labels.push({ x, cm: Math.round(cm) });
    }
    const last = labels[labels.length - 1];
    ctx.textAlign = "center";
    labels.forEach((label) => {
      if (label === last) return;
      ctx.fillText(String(label.cm), label.x, 2);
    });
    if (last) {
      const text = `${last.cm} cm`;
      const textW = ctx.measureText(text).width;
      ctx.textAlign = "left";
      const x = Math.min(last.x - ctx.measureText(String(last.cm)).width / 2, width - 4 - textW);
      ctx.fillText(text, Math.max(2, x), 2);
    }
    ctx.beginPath();
    ctx.moveTo(0, RULER - 0.5);
    ctx.lineTo(width, RULER - 0.5);
    ctx.stroke();
  }

  function drawBalance(plane, wing, height) {
    const cg = toScreen({ x: plane.cg, y: 0 });
    const ac = toScreen({ x: plane.neutralPoint, y: 0 });
    const color = plane.staticMargin >= 0 ? "#1d7a4a" : "#9a3b28";
    const yb = cg.y - 10;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cg.x, yb - 5);
    ctx.lineTo(cg.x, yb);
    ctx.lineTo(ac.x, yb);
    ctx.lineTo(ac.x, yb - 5);
    ctx.stroke();

    const halfPx = Math.abs(cg.y - toScreen({ x: 0, y: wing.half }).y);
    const lift = halfPx < 48 ? halfPx + 36 : 32;
    const close = Math.abs(cg.x - ac.x) < 36;
    const nudge = close ? 22 : 0;
    const cgY = Math.max(RULER + 14, cg.y - lift);
    const acY = Math.min(height - 14, ac.y + lift);
    drawStation(cg, color, "CG", cg.x - nudge, cgY);
    drawStation(ac, color, "AC", ac.x + nudge, acY);
  }

  function drawStation(dot, color, label, labelX, labelY) {
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.font = uiFont(12);
    const w = ctx.measureText(label).width + 10;
    const h = 16;
    const x = labelX - w / 2;
    const y = labelY - h / 2;
    ctx.beginPath();
    ctx.moveTo(dot.x, dot.y);
    ctx.lineTo(labelX, labelY);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
    roundRect(x, y, w, h, h / 2);
    ctx.fillStyle = "#fffaf4";
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.fillStyle = "#243027";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, labelX, labelY + 0.5);
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  function drawHandle(place, active) {
    ctx.beginPath();
    ctx.arc(place.x, place.y, HANDLE_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = active ? "#d2652d" : "#fff";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#243027";
    ctx.stroke();
  }

  function tipText(id, current) {
    if (id === "span") return `${(current.span * 100).toFixed(1)} cm`;
    if (id === "rootChord") return `${(current.rootChord * 100).toFixed(1)} cm`;
    if (id === "tipChord") return `${(current.tipChord * 100).toFixed(1)} cm`;
    if (id === "sweep") return `${current.sweepDeg.toFixed(0)}°`;
    return `${(current.tailArea * 10000).toFixed(0)} cm²`;
  }

  function drawTooltip(text, anchor, width, height) {
    ctx.font = uiFont(12);
    const w = ctx.measureText(text).width + 12;
    const h = 18;
    let x = anchor.x + 12;
    let y = anchor.y - h - 10;
    if (x + w > width - 4) x = anchor.x - w - 12;
    if (y < RULER + 2) y = Math.min(height - h - 4, anchor.y + 12);
    roundRect(x, y, w, h, 4);
    ctx.fillStyle = "#243027";
    ctx.fill();
    ctx.fillStyle = "#fbf8f2";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + 6, y + h / 2);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function redraw() {
    draw();
  }

  function onDown(event) {
    const pointer = pointerPoint(event);
    const handle = hitHandle(pointer.x, pointer.y);
    if (!handle) return;
    drag = handle;
    hover = handle;
    frame = shapeBox(shape());
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // The pointer can already be gone, and synthetic events have no capture target.
    }
    canvas.style.cursor = "grabbing";
    event.preventDefault();
    draw();
  }

  function onMove(event) {
    const pointer = pointerPoint(event);
    if (drag) {
      const world = toWorld(pointer.x - drag.ox, pointer.y - drag.oy);
      const signed = drag.side < 0 ? { x: world.x, y: -Math.abs(world.y) } : world;
      setShape(shapeFromHandle(shape(), drag.id, signed));
      canvas.style.cursor = "grabbing";
      return;
    }
    hover = hitHandle(pointer.x, pointer.y);
    canvas.style.cursor = hover ? "grab" : "default";
    draw();
  }

  function onUp() {
    drag = null;
    frame = null;
    canvas.style.cursor = hover ? "grab" : "default";
    draw();
  }

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  const observer = new ResizeObserver(() => draw());
  observer.observe(canvas);
  draw();

  return { redraw };
}

export { HANDLES, clampShape, handlePosition, initEditor, shapeFromHandle };
