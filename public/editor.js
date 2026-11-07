// Top-down shape editor. Planform math matches plane.js exactly so a handle
// position and its shape value round-trip. x is meters aft of the nose.

import { PAPER, SHAPE_LIMITS, defaultShape, derivePlane } from "./plane.js";

const HANDLES = ["span", "rootChord", "tipChord", "sweep", "tail"];

const HIT_RADIUS = 12;
const HANDLE_RADIUS = 5;

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

  function shape() {
    return clampShape(getShape());
  }

  function fit() {
    // Fit the largest planform the sliders can make, so a drag does not
    // zoom the camera out from under the pointer.
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
    const pad = 0.04;
    const minX = Math.min(0, wing.xLeTip) - pad;
    const maxX = Math.max(derivePlane(wide).bodyLength, derivePlane(longTail).bodyLength, wing.xTeTip) + pad;
    const minY = -wing.half - pad;
    const maxY = wing.half + pad;
    const width = canvas.clientWidth || 320;
    const height = canvas.clientHeight || 220;
    const scale = Math.min(width / (maxX - minX), height / (maxY - minY));
    camera = {
      minX,
      maxY,
      scale,
      offsetX: (width - (maxX - minX) * scale) / 2,
      offsetY: (height - (maxY - minY) * scale) / 2,
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

  function hitHandle(px, py) {
    let best = null;
    let bestDistance = HIT_RADIUS;
    for (const handle of handlePoints()) {
      const screen = toScreen(handle);
      const distance = Math.hypot(screen.x - px, screen.y - py);
      if (distance <= bestDistance) {
        best = handle;
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
    const width = canvas.clientWidth || 320;
    const height = canvas.clientHeight || 220;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    fit();

    ctx.clearRect(0, 0, width, height);
    drawGrid(width, height);

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
    ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
    ctx.strokeStyle = "#1d4e73";
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
    ctx.fillStyle = "rgba(255, 255, 255, 0.82)";
    ctx.fill();
    ctx.stroke();

    const nose = toScreen({ x: 0, y: 0 });
    const stern = toScreen({ x: plane.bodyLength, y: 0 });
    ctx.beginPath();
    ctx.moveTo(nose.x, nose.y);
    ctx.lineTo(stern.x, stern.y);
    ctx.strokeStyle = "#16364d";
    ctx.lineWidth = Math.max(2, PAPER.fuselageWidth * camera.scale);
    ctx.lineCap = "round";
    ctx.stroke();

    const weight = toScreen({ x: 0, y: 0 });
    ctx.beginPath();
    ctx.arc(weight.x, weight.y, 3.5 + current.noseWeight * 0.7, 0, Math.PI * 2);
    ctx.fillStyle = "#e07a3d";
    ctx.fill();

    const stable = plane.staticMargin >= 0;
    drawMarker(plane.cg, stable, "CG");
    drawMarker(plane.neutralPoint, stable, "AC");

    for (const handle of handlePoints()) {
      const active = drag?.id === handle.id || hover?.id === handle.id;
      const screen = toScreen(handle);
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, active ? HANDLE_RADIUS + 1.5 : HANDLE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = active ? "#e07a3d" : "#ffffff";
      ctx.strokeStyle = "#1d4e73";
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
    }
  }

  function drawGrid(width, height) {
    const start = Math.ceil(camera.minX * 100);
    const end = Math.floor((camera.minX + width / camera.scale) * 100);
    const yTop = camera.maxY;
    const yBottom = camera.maxY - height / camera.scale;
    ctx.lineWidth = 1;
    ctx.font = "11px Segoe UI, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    for (let cm = Math.ceil(yBottom * 100); cm <= Math.floor(yTop * 100); cm += 1) {
      const screen = toScreen({ x: camera.minX, y: cm / 100 });
      ctx.strokeStyle = cm % 5 === 0 ? "rgba(22, 54, 77, 0.16)" : "rgba(22, 54, 77, 0.07)";
      ctx.beginPath();
      ctx.moveTo(0, screen.y);
      ctx.lineTo(width, screen.y);
      ctx.stroke();
    }
    for (let cm = start; cm <= end; cm += 1) {
      const screen = toScreen({ x: cm / 100, y: 0 });
      ctx.strokeStyle = cm % 5 === 0 ? "rgba(22, 54, 77, 0.16)" : "rgba(22, 54, 77, 0.07)";
      ctx.beginPath();
      ctx.moveTo(screen.x, 0);
      ctx.lineTo(screen.x, height);
      ctx.stroke();
      if (cm % 5 === 0) {
        ctx.fillStyle = "rgba(22, 54, 77, 0.55)";
        ctx.fillText(String(cm), screen.x + 3, 4);
      }
    }
  }

  function drawMarker(x, stable, label) {
    const screen = toScreen({ x, y: 0 });
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = stable ? "#1d7a4a" : "#b4452a";
    ctx.fill();
    ctx.font = "12px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(label, screen.x, screen.y - 7);
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
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = "grabbing";
    event.preventDefault();
    draw();
  }

  function onMove(event) {
    const pointer = pointerPoint(event);
    if (drag) {
      const world = toWorld(pointer.x, pointer.y);
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
