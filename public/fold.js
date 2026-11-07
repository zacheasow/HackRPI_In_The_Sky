/**
 * Paper folding animation. A CSS 3D rig of paper panels is folded into the
 * current airplane shape by an anime.js v4 timeline.
 *
 * The timeline only ever drives plain numbers in `fold`; render() turns those
 * numbers into panel transforms, so seeking the scrubber lands on exactly the
 * pose playback would have reached.
 *
 * Panel layout, in design units, with the paper lying in the XY plane and the
 * nose at -Y:
 *   left half  x [-halfSpan, 0], hinged on the spine at x = 0
 *   right half x [0, halfSpan], hinged on the spine at x = 0
 *   two triangular nose flaps per half, hinged on diagonal creases
 *   a keel below the spine, opened out of the body as the wings come down
 */

import { createTimeline } from "/vendor/animejs/bundles/anime.esm.js";
import { SHAPE_LIMITS } from "./plane.js";

const FALLBACK_SHAPE = {
  span: 0.36,
  rootChord: 0.07,
  tipChord: 0.04,
  sweepDeg: 5,
  tailArea: 0.006,
  noseWeight: 1,
};

// One fixed three-quarter view for the whole fold.
const CAMERA = { tilt: -56, spin: -16 };

// Timeline beats, in ms. The caption follows these.
const STEPS = [
  { at: 0, label: "Flat sheet" },
  { at: 560, label: "Center crease" },
  { at: 1950, label: "Top corners to the center line" },
  { at: 2800, label: "New edges to the center again" },
  { at: 3650, label: "Fold in half along the spine" },
  { at: 4450, label: "Wings down" },
];
const TOTAL = 5350;

function clamp(value, [min, max], fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function norm(value, [min, max]) {
  if (max === min) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

const percent = (n) => `${n.toFixed(2)}%`;
const polygonOf = (points) => `polygon(${points.map(([x, y]) => `${percent(x)} ${percent(y)}`).join(", ")})`;

function axis(dx, dy) {
  const length = Math.hypot(dx, dy) || 1;
  return { x: dx / length, y: dy / length };
}

function setBox(el, x, y, width, height) {
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
}

function setClip(piece, clip) {
  piece.front.style.clipPath = clip;
  piece.back.style.clipPath = clip;
}

function createPiece(parent, className) {
  const el = document.createElement("div");
  el.className = `fold-piece ${className}`;
  const front = document.createElement("div");
  front.className = "fold-face fold-face-front";
  const back = document.createElement("div");
  back.className = "fold-face fold-face-back";
  el.append(front, back);
  parent.append(el);
  return { el, front, back };
}

/**
 * Shape values -> paper dimensions. Span sets the wings, the root chord sets
 * the paper length, the chord ratio sets the taper, sweep tips the leading
 * edge back, and the nose weight adds dihedral (a heavier nose wants more
 * wing-down angle).
 */
function measureShape(shape) {
  const span = clamp(shape.span, SHAPE_LIMITS.span, FALLBACK_SHAPE.span);
  const rootChord = clamp(shape.rootChord, SHAPE_LIMITS.rootChord, FALLBACK_SHAPE.rootChord);
  const tipChord = clamp(shape.tipChord, SHAPE_LIMITS.tipChord, FALLBACK_SHAPE.tipChord);
  const sweepDeg = clamp(shape.sweepDeg, SHAPE_LIMITS.sweepDeg, FALLBACK_SHAPE.sweepDeg);
  const noseWeight = clamp(shape.noseWeight, SHAPE_LIMITS.noseWeight, FALLBACK_SHAPE.noseWeight);

  const spanNorm = norm(span, SHAPE_LIMITS.span);
  const chordNorm = norm(rootChord, SHAPE_LIMITS.rootChord);
  const noseNorm = norm(noseWeight, SHAPE_LIMITS.noseWeight);

  const halfSpan = 92 + 56 * spanNorm; // half the paper width
  const length = 282 + 66 * chordNorm; // root chord, nose to trailing edge
  const taper = Math.min(1, Math.max(0.18, tipChord / Math.max(rootChord, 1e-6)));
  const tipChordPx = length * taper; // root chord is the whole paper length
  // Leading edge at the tip: quarter-chord sweep plus the taper's own offset.
  const sweepPx = Math.min(
    Math.max(0.25 * (length - tipChordPx) + Math.tan((sweepDeg * Math.PI) / 180) * halfSpan, 0),
    Math.max(0, length * 0.9 - tipChordPx)
  );

  // The first nose fold is the classic 45 degree crease, so the corner lands
  // on the center line. The second crease is steeper and clips the new edge.
  const h1 = Math.min(halfSpan, length * 0.82);
  const h2 = Math.min(h1 * 1.85, length * 0.92);

  return {
    halfSpan,
    length,
    h1,
    h2,
    h1Pct: (h1 / length) * 100,
    h2Pct: (h2 / length) * 100,
    sweepPct: (sweepPx / length) * 100,
    tePct: ((sweepPx + tipChordPx) / length) * 100,
    dihedral: 10 + 4 * spanNorm + 2 * noseNorm,
    keelDepth: Math.max(22, length * 0.1),
    axisL1: axis(-halfSpan, h1),
    axisL2: axis(-halfSpan, h2),
    axisR1: axis(halfSpan, h1),
    axisR2: axis(halfSpan, h2),
  };
}

export function initFold(container, getShape) {
  if (!container) return null;
  const stage = container.querySelector(".fold-stage");
  const playButton = container.querySelector('[data-fold="play"]');
  const replayButton = container.querySelector('[data-fold="replay"]');
  const scrub = container.querySelector('[data-fold="scrub"]');
  const caption = container.querySelector(".fold-caption");
  if (!stage) return null;

  const rig = document.createElement("div");
  rig.className = "fold-rig";
  const sheet = document.createElement("div");
  sheet.className = "fold-sheet";
  const shadow = document.createElement("div");
  shadow.className = "fold-shadow";
  sheet.append(shadow);
  const keelRight = createPiece(sheet, "fold-keel fold-keel-right");
  const keelLeft = createPiece(sheet, "fold-keel fold-keel-left");
  rig.append(sheet);
  stage.append(rig);

  const right = createPiece(sheet, "fold-half fold-half-right");
  const left = createPiece(sheet, "fold-half fold-half-left");
  const flapR1 = createPiece(right.el, "fold-flap fold-flap-1");
  const flapR2 = createPiece(right.el, "fold-flap fold-flap-2");
  const flapL1 = createPiece(left.el, "fold-flap fold-flap-1");
  const flapL2 = createPiece(left.el, "fold-flap fold-flap-2");

  let geometry = measureShape(FALLBACK_SHAPE);
  let scale = 1;
  let timeline = null;
  let playing = false;
  let lastWing = -1;
  let refoldTimer = 0;

  // Every animated number lives here. Nothing else is tweened.
  const fold = {
    crease: 0,
    cornerL: 0,
    cornerR: 0,
    edgeL: 0,
    edgeR: 0,
    spineL: 0,
    spineR: 0,
    wing: 0,
    flaps: 1,
    keel: 0,
  };

  function applyWing(t) {
    const { sweepPct, tePct } = geometry;
    const sweep = sweepPct * t;
    const tail = 100 + (tePct - 100) * t;
    setClip(left, polygonOf([[100, 0], [0, sweep], [0, tail], [100, 100]]));
    setClip(right, polygonOf([[0, 0], [100, sweep], [100, tail], [0, 100]]));
    lastWing = t;
  }

  function applyGeometry() {
    const { halfSpan, length, h1Pct, h2Pct } = geometry;
    setBox(left.el, -halfSpan, -length / 2, halfSpan, length);
    setBox(right.el, 0, -length / 2, halfSpan, length);
    left.el.style.transformOrigin = "100% 50%";
    right.el.style.transformOrigin = "0% 50%";

    setBox(shadow, -halfSpan * 1.06, -length * 0.53, halfSpan * 2.12, length * 1.06);

    // The keel is the folded body: two plates hinged on the spine, angled down
    // and apart so it hangs below the wings. It stays at zero width (and so
    // out of sight) until the body opens on the wings-down step.
    const keelProfile = polygonOf([[0, 0], [100, 26], [100, 90], [0, 100]]);
    for (const plate of [keelLeft, keelRight]) {
      setBox(plate.el, 0, -length / 2, geometry.keelDepth, length);
      plate.el.style.transformOrigin = "0% 50%";
      setClip(plate, keelProfile);
    }

    rig.style.transform = `rotateX(${CAMERA.tilt}deg) rotateZ(${CAMERA.spin}deg)`;

    flapL1.el.style.transformOrigin = "100% 0%";
    flapL2.el.style.transformOrigin = "100% 0%";
    flapR1.el.style.transformOrigin = "0% 0%";
    flapR2.el.style.transformOrigin = "0% 0%";

    setClip(flapL1, polygonOf([[100, 0], [0, 0], [0, h1Pct]]));
    setClip(flapL2, polygonOf([[100, 0], [0, h1Pct], [0, h2Pct]]));
    setClip(flapR1, polygonOf([[0, 0], [100, 0], [100, h1Pct]]));
    setClip(flapR2, polygonOf([[0, 0], [100, h1Pct], [100, h2Pct]]));

    lastWing = -1;
    fitScale();
    applyWing(fold.wing);
  }

  function fitScale() {
    const rect = stage.getBoundingClientRect();
    const width = Math.max(180, rect.width || 320);
    const height = Math.max(180, rect.height || 320);
    const { halfSpan, length, keelDepth } = geometry;
    const tilt = Math.abs(Math.cos((CAMERA.tilt * Math.PI) / 180));
    const byWidth = (width * 0.72) / (2 * halfSpan);
    const byDepth = (height * 0.8) / (length * tilt + keelDepth);
    scale = Math.max(0.4, Math.min(byWidth, byDepth));
  }

  function render() {
    sheet.style.transform = `scale(${scale})`;

    const spread = fold.keel.toFixed(4);
    keelLeft.el.style.transform = `rotateY(125deg) scaleX(${spread})`;
    keelRight.el.style.transform = `rotateY(55deg) scaleX(${spread})`;

    // The center-crease press and the half fold share the same spine hinge.
    left.el.style.transform = `translateZ(0.6px) rotateY(${fold.spineL + fold.crease}deg)`;
    right.el.style.transform = `rotateY(${fold.spineR}deg)`;

    const { axisL1, axisL2, axisR1, axisR2 } = geometry;
    flapL1.el.style.transform = `translateZ(1.4px) rotate3d(${axisL1.x}, ${axisL1.y}, 0, ${fold.cornerL}deg)`;
    flapL2.el.style.transform = `translateZ(2.8px) rotate3d(${axisL2.x}, ${axisL2.y}, 0, ${fold.edgeL}deg)`;
    flapR1.el.style.transform = `translateZ(1.4px) rotate3d(${axisR1.x}, ${axisR1.y}, 0, ${fold.cornerR}deg)`;
    flapR2.el.style.transform = `translateZ(2.8px) rotate3d(${axisR2.x}, ${axisR2.y}, 0, ${fold.edgeR}deg)`;

    const fade = fold.flaps.toFixed(3);
    for (const flap of [flapL1, flapL2, flapR1, flapR2]) {
      flap.front.style.opacity = fade;
      flap.back.style.opacity = fade;
    }

    if (fold.wing !== lastWing) applyWing(fold.wing);
  }

  function stepLabel(time) {
    let label = STEPS[0].label;
    for (const step of STEPS) if (time >= step.at) label = step.label;
    return label;
  }

  function syncControls(time) {
    if (scrub) scrub.value = String(Math.round(time));
    if (caption) {
      const label = stepLabel(time);
      if (caption.textContent !== label) caption.textContent = label;
    }
  }

  function setPlaying(next) {
    playing = next;
    if (playButton) playButton.textContent = next ? "Pause" : "Fold";
  }

  function onTick() {
    render();
    if (timeline) syncControls(timeline.currentTime);
  }

  function buildTimeline() {
    if (timeline) timeline.pause();
    Object.assign(fold, {
      crease: 0,
      cornerL: 0,
      cornerR: 0,
      edgeL: 0,
      edgeR: 0,
      spineL: 0,
      spineR: 0,
      wing: 0,
      flaps: 1,
    });

    const dihedral = geometry.dihedral;
    const next = createTimeline({
      autoplay: false,
      defaults: { duration: 600, ease: "inOutQuad" },
      onUpdate: onTick,
      onComplete: () => setPlaying(false),
    });

    // 1. Center crease: press the sheet in half, hold, then open it again.
    next.add(
      fold,
      {
        crease: [
          { to: 180, duration: 620, ease: "inQuad" },
          { to: 180, duration: 140 },
          { to: 0, duration: 560, ease: "outQuad" },
        ],
      },
      560
    );
    // 2. Top corners to the center line, then the new edges again.
    next.add(fold, { cornerL: 180, duration: 640, ease: "inOutQuad" }, 1950);
    next.add(fold, { cornerR: 180, duration: 640, ease: "inOutQuad" }, 2200);
    next.add(fold, { edgeL: 180, duration: 640, ease: "inOutQuad" }, 2800);
    next.add(fold, { edgeR: 180, duration: 640, ease: "inOutQuad" }, 3020);
    // 3. Fold in half along the spine, then 4. open the body into the wings-down V.
    next.add(
      fold,
      {
        spineL: [
          { to: 180, duration: 720, ease: "inOutQuad" },
          { to: 180, duration: 80 },
          { to: dihedral, duration: 900, ease: "outCubic" },
        ],
      },
      3650
    );
    next.add(fold, { spineR: -dihedral, duration: 900, ease: "outCubic" }, 4450);
    next.add(fold, { wing: 1, duration: 900, ease: "inOutQuad" }, 4450);
    // The body opens into the keel below the wings.
    next.add(fold, { keel: 1, duration: 900, ease: "outCubic" }, 4450);
    // The nose folds end up inside the body once the wings come down.
    next.add(fold, { flaps: 0, duration: 460, ease: "inQuad" }, 4450);

    timeline = next;
    if (scrub) scrub.max = String(Math.round(TOTAL));
    // anime.js seek() resumes a running timer, so pause before the first seek.
    timeline.pause();
    timeline.seek(0, true);
    render();
    syncControls(0);
  }

  function play() {
    if (!timeline) return;
    if (timeline.completed || timeline.currentTime >= TOTAL - 1) {
      timeline.pause();
      timeline.seek(0, true);
      render();
    }
    timeline.play();
    setPlaying(true);
  }

  function replay() {
    if (!timeline) return;
    timeline.pause();
    timeline.seek(0, true);
    render();
    syncControls(0);
    timeline.play();
    setPlaying(true);
  }

  function update() {
    geometry = measureShape(getShape() || FALLBACK_SHAPE);
    applyGeometry();
    buildTimeline();
  }

  function scheduleRefold() {
    window.clearTimeout(refoldTimer);
    refoldTimer = window.setTimeout(() => {
      update();
      replay();
    }, 220);
  }

  if (playButton) {
    playButton.addEventListener("click", () => {
      if (playing) {
        timeline?.pause();
        setPlaying(false);
      } else {
        play();
      }
    });
  }
  if (replayButton) replayButton.addEventListener("click", replay);
  if (scrub) {
    scrub.addEventListener("input", () => {
      if (!timeline) return;
      timeline.pause();
      setPlaying(false);
      const time = Number(scrub.value);
      timeline.seek(time, true);
      render();
      syncControls(time);
    });
  }

  // Re-fold when a shape slider moves; the fold follows the new shape.
  document.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.id.startsWith("shape-")) return;
    scheduleRefold();
  });

  const observer = new ResizeObserver(() => {
    fitScale();
    render();
  });
  observer.observe(stage);

  update();
  return { play, replay, update };
}
