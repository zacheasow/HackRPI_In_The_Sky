/**
 * 2D side-view paper-airplane flight model.
 * No DOM access. Tune behavior from CONFIG below.
 *
 * Coordinates: +x forward, +y up. Pitch theta is radians from the horizon,
 * positive nose-up. Pitch rate q is radians/second, positive nose-up.
 */

export const CONFIG = {
  // Integration
  dt: 0.002, // fixed timestep, seconds. Semi-implicit Euler.
  maxFlightTime: 40, // safety cap so a loop cannot run forever, seconds
  sampleInterval: 0.02, // seconds between recorded trajectory points
  minAirspeed: 0.25, // below this, aerodynamic forces are treated as zero, m/s
  maxRange: 400, // end the flight if x runs away, meters
  maxAltitude: 150, // end the flight if y runs away, meters

  // Atmosphere and gravity
  rho: 1.225, // air density, kg/m^3
  g: 9.81, // m/s^2, applied at the center of gravity (no pitching moment)

  // Wing lift. Linear slope is clAlpha * alpha * AR / (AR + 2), alpha in radians.
  // cl0 is camber lift at zero alpha. Leave at 0 to match the thin-airfoil formula.
  clAlpha: 2 * Math.PI,
  cl0: 0,
  stallAngleDeg: 15, // linear range ends here, then CL eases toward a flat plate
  stallBlendDeg: 12, // width of that ease, degrees past the stall angle
  cd0: 0.05, // parasite drag coefficient
  oswald: 0.8, // Oswald efficiency in CD = CD0 + CL^2 / (pi * e * AR)
  // Extra drag blended in after the stall, scaled by sin(alpha)^2.
  // Set to 0 to use only the induced-drag formula.
  postStallDrag: 1.1,

  // Tail. Local alpha includes downwash, incidence, and a pitch-rate term.
  tailClAlpha: 2 * Math.PI * 0.65, // per radian, already includes a low-aspect-ratio cut
  tailStallAngleDeg: 12,
  tailCd0: 0.04,
  tailAspectRatio: 3, // used only for tail induced drag
  downwash: 0.4, // fraction of wing alpha the tail does not see

  // Extra pitch damping on top of the tail's pitch-rate alpha.
  // Moment -= pitchDamping * q * dynamicPressure * S * chord^2
  pitchDamping: 0.08,

  // Wind. Positive speed is a tailwind (air moving in the +x throw direction).
  // simulate() with no wind argument stays 'off' and matches the calm model.
  // The page starts in the mode named here.
  wind: {
    mode: "random", // 'random' | 'fixed' | 'off'
    seed: 1, // mulberry32 seed. The same seed repeats the same wind.
    steadyMin: -4, // m/s, headwind end of the random steady roll
    steadyMax: 4, // m/s, tailwind end of the random steady roll
    fixedSpeed: 0, // m/s used when mode is 'fixed'
    gustAmplitude: 0.8, // m/s, size of the slow unsteady part
    gustTimescale: 1.5, // seconds, period of the slowest gust
    verticalFraction: 0.3, // windY amplitude relative to gustAmplitude
  },

  // Input clamps. Anything outside these, or NaN, is pulled back in.
  limits: {
    speed: [2, 15], // m/s
    angleDeg: [-10, 45],
    height: [0.5, 3],
    wingArea: [0.004, 0.08], // m^2
    aspectRatio: [0.8, 14],
    mass: [0.0005, 0.05], // kg, light enough for a small 80 gsm wing
    cg: [0, 0.8], // m from the nose, aft positive
    ac: [0, 0.8],
    meanChord: [0.02, 0.25],
    bodyLength: [0.08, 0.6],
    tailArea: [0, 0.02],
    tailArm: [0.004, 0.7],
    tailIncidence: [-0.35, 0.35], // radians, negative trims nose-up
    inertia: [1e-6, 0.002], // kg m^2
  },
};

const DEG = Math.PI / 180;

function clamp(value, [min, max], fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function smoothstep(edge0, edge1, x) {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function wrapAngle(angle) {
  const twoPi = Math.PI * 2;
  let wrapped = (angle + Math.PI) % twoPi;
  if (wrapped < 0) wrapped += twoPi;
  return wrapped - Math.PI;
}

function finiteState(state) {
  return [state.x, state.y, state.vx, state.vy, state.theta, state.q].every(Number.isFinite);
}

/** Seeded generator in [0, 1). The flight model never calls Math.random. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function windSeed(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return CONFIG.wind.seed >>> 0;
  return n >>> 0;
}

/**
 * One launch's wind. Random mode rolls a single steady windX from the seed.
 * Gust phases come from the same generator, so a seed repeats exactly.
 */
export function resolveWind(windInput) {
  const cfg = CONFIG.wind;
  const requested = windInput == null ? { mode: "off" } : windInput;
  const mode = requested.mode === "random" || requested.mode === "fixed" || requested.mode === "off"
    ? requested.mode
    : "off";
  const seed = windSeed(requested.seed ?? cfg.seed);

  if (mode === "off") {
    return { mode: "off", seed, steady: 0, phases: [0, 0, 0, 0] };
  }

  const rand = mulberry32(seed);
  let steady = 0;
  if (mode === "fixed") {
    const speed = Number(requested.fixedSpeed ?? cfg.fixedSpeed);
    steady = clamp(speed, [cfg.steadyMin, cfg.steadyMax], cfg.fixedSpeed);
  } else {
    steady = cfg.steadyMin + rand() * (cfg.steadyMax - cfg.steadyMin);
  }
  const phases = [rand(), rand(), rand(), rand()].map((unit) => unit * Math.PI * 2);
  return { mode, seed, steady, phases };
}

function gustAt(t, phases) {
  const period = CONFIG.wind.gustTimescale;
  const amp = CONFIG.wind.gustAmplitude;
  const base = (2 * Math.PI) / period;
  const along =
    Math.sin(base * t + phases[0]) +
    0.55 * Math.sin(base * 1.9 * t + phases[1]) +
    0.3 * Math.sin(base * 3.1 * t + phases[2]);
  const lift =
    Math.sin(base * 1.4 * t + phases[3]) + 0.45 * Math.sin(base * 2.5 * t + phases[1]);
  return {
    x: (amp * along) / (1 + 0.55 + 0.3),
    y: ((amp * CONFIG.wind.verticalFraction) * lift) / (1 + 0.45),
  };
}

/** Steady wind plus the gust at time t. Off mode is exactly zero. */
export function windVelocity(wind, t) {
  if (!wind || wind.mode === "off") return { x: 0, y: 0 };
  const gust = gustAt(t, wind.phases);
  return { x: wind.steady + gust.x, y: gust.y };
}

/**
 * Wing CL and CD at a given angle of attack.
 * CL follows the finite-wing linear slope until stallAngleDeg, then eases
 * toward the flat-plate value sin(2 * alpha).
 */
export function wingCoefficients(alpha, aspectRatio) {
  const ar = Math.max(aspectRatio, 0.3);
  const stall = CONFIG.stallAngleDeg * DEG;
  const blendEnd = stall + CONFIG.stallBlendDeg * DEG;
  const slope = CONFIG.clAlpha * (ar / (ar + 2));
  const clLinear = CONFIG.cl0 + slope * alpha;
  const clFlat = Math.sin(2 * alpha);
  const absAlpha = Math.abs(alpha);

  let cl = clLinear;
  let stalled = false;
  if (absAlpha > stall) {
    stalled = true;
    const weight = smoothstep(stall, blendEnd, absAlpha);
    const sign = Math.sign(alpha) || 1;
    const linearAtStall = CONFIG.cl0 + slope * stall * sign;
    cl = linearAtStall * (1 - weight) + clFlat * weight;
  }

  let cd = CONFIG.cd0 + (cl * cl) / (Math.PI * CONFIG.oswald * ar);
  if (absAlpha > stall && CONFIG.postStallDrag > 0) {
    const weight = smoothstep(stall, blendEnd, absAlpha);
    cd += CONFIG.postStallDrag * Math.sin(alpha) * Math.sin(alpha) * weight;
  }

  return { cl, cd, stalled };
}

function tailCoefficient(alpha) {
  const stall = CONFIG.tailStallAngleDeg * DEG;
  const blendEnd = stall + CONFIG.stallBlendDeg * DEG;
  const linear = CONFIG.tailClAlpha * alpha;
  if (Math.abs(alpha) <= stall) return linear;
  const weight = smoothstep(stall, blendEnd, Math.abs(alpha));
  const atStall = CONFIG.tailClAlpha * stall * Math.sign(alpha || 1);
  return atStall * (1 - weight) + Math.sin(2 * alpha) * weight;
}

/**
 * Pull plane and launch inputs into the ranges the integrator can survive.
 * Missing or NaN fields fall back to a flyable paper glider.
 */
export function sanitizeInputs(plane = {}, launch = {}) {
  const limits = CONFIG.limits;
  const wingArea = clamp(plane.wingArea, limits.wingArea, 0.015);
  const aspectRatio = clamp(plane.aspectRatio, limits.aspectRatio, 5.5);
  const span = Math.sqrt(wingArea * aspectRatio);
  const chordGuess = span > 0 ? wingArea / span : 0.07;

  const mass = clamp(plane.mass, limits.mass, 0.01);
  const meanChord = clamp(plane.meanChord, limits.meanChord, chordGuess);
  const bodyLength = clamp(plane.bodyLength, limits.bodyLength, Math.max(0.28, meanChord * 3.5));
  const inertiaGuess = (mass * bodyLength * bodyLength) / 12;

  return {
    plane: {
      wingArea,
      aspectRatio,
      mass,
      cg: clamp(plane.cg, limits.cg, 0.062),
      ac: clamp(plane.ac, limits.ac, 0.08),
      meanChord,
      bodyLength,
      tailArea: clamp(plane.tailArea, limits.tailArea, 0.004),
      tailArm: clamp(plane.tailArm, limits.tailArm, 0.16),
      tailIncidence: clamp(plane.tailIncidence, limits.tailIncidence, -0.145),
      inertia: clamp(plane.inertia, limits.inertia, inertiaGuess),
    },
    launch: {
      speed: clamp(launch.speed, limits.speed, 7),
      angleDeg: clamp(launch.angleDeg, limits.angleDeg, 4),
      height: clamp(launch.height, limits.height, 1.5),
    },
  };
}

function aerodynamicDerivatives(state, plane, windX = 0, windY = 0) {
  const { vx, vy, theta, q } = state;
  // A calm launch keeps the original ground-velocity expressions, so mode 'off'
  // stays bit-for-bit with the no-wind model. Any real wind uses air-relative velocity.
  const calm = windX === 0 && windY === 0;
  const airVx = calm ? vx : vx - windX;
  const airVy = calm ? vy : vy - windY;
  const speed = Math.hypot(airVx, airVy);
  let ax = 0;
  let ay = -CONFIG.g;
  let moment = 0;
  let alpha = 0;
  let stalled = false;

  if (speed >= CONFIG.minAirspeed) {
    const gamma = Math.atan2(airVy, airVx);
    alpha = wrapAngle(theta - gamma);
    const { cl, cd, stalled: wingStalled } = wingCoefficients(alpha, plane.aspectRatio);
    stalled = wingStalled;

    const dynamicPressure = 0.5 * CONFIG.rho * speed * speed;
    const lift = dynamicPressure * plane.wingArea * cl;
    const drag = dynamicPressure * plane.wingArea * cd;

    const ux = airVx / speed;
    const uy = airVy / speed;
    // Positive lift is 90 degrees counter-clockwise from velocity.
    const px = -uy;
    const py = ux;

    let fx = -drag * ux + lift * px;
    let fy = -drag * uy + lift * py;

    const noseX = Math.cos(theta);
    const noseY = Math.sin(theta);
    // AC aft of the CG sits opposite the nose. Positive lift there noses down.
    const arm = plane.ac - plane.cg;
    const rx = -arm * noseX;
    const ry = -arm * noseY;
    moment += rx * fy - ry * fx;

    if (plane.tailArea > 0 && plane.tailArm > 0) {
      const tailAlpha =
        alpha * (1 - CONFIG.downwash) +
        plane.tailIncidence +
        (q * plane.tailArm) / speed;
      const clTail = tailCoefficient(tailAlpha);
      const cdTail =
        CONFIG.tailCd0 +
        (clTail * clTail) / (Math.PI * CONFIG.oswald * CONFIG.tailAspectRatio);
      const tailLift = dynamicPressure * plane.tailArea * clTail;
      const tailDrag = dynamicPressure * plane.tailArea * cdTail;
      const ftx = -tailDrag * ux + tailLift * px;
      const fty = -tailDrag * uy + tailLift * py;
      const trx = -plane.tailArm * noseX;
      const tryArm = -plane.tailArm * noseY;
      moment += trx * fty - tryArm * ftx;
      fx += ftx;
      fy += fty;
    }

    const chord = plane.meanChord;
    moment -= CONFIG.pitchDamping * q * dynamicPressure * plane.wingArea * chord * chord;

    ax += fx / plane.mass;
    ay += fy / plane.mass;
  }

  const qDot = moment / plane.inertia;
  if (![ax, ay, qDot, alpha].every(Number.isFinite)) {
    return null;
  }
  return { ax, ay, qDot, alpha, stalled };
}

function stepState(state, plane, dt, windX, windY) {
  const derivatives = aerodynamicDerivatives(state, plane, windX, windY);
  if (!derivatives) return null;

  const vx = state.vx + derivatives.ax * dt;
  const vy = state.vy + derivatives.ay * dt;
  const q = state.q + derivatives.qDot * dt;
  const next = {
    x: state.x + vx * dt,
    y: state.y + vy * dt,
    vx,
    vy,
    theta: state.theta + q * dt,
    q,
  };
  if (!finiteState(next)) return null;
  return { state: next, alpha: derivatives.alpha, stalled: derivatives.stalled };
}

function interpolateToGround(before, after) {
  const drop = before.y - after.y;
  const fraction = drop <= 1e-9 ? 1 : before.y / drop;
  const mix = (a, b) => a + (b - a) * fraction;
  return {
    state: {
      x: mix(before.x, after.x),
      y: 0,
      vx: mix(before.vx, after.vx),
      vy: mix(before.vy, after.vy),
      theta: mix(before.theta, after.theta),
      q: mix(before.q, after.q),
    },
    dt: CONFIG.dt * Math.min(1, Math.max(0, fraction)),
  };
}

/**
 * Fly until the airplane reaches the ground, a safety limit, or a bad number.
 * Distance is the final x position, in meters.
 */
export function simulate(planeInput, launchInput, windInput) {
  const { plane, launch } = sanitizeInputs(planeInput, launchInput);
  const windField = resolveWind(windInput);
  const angle = launch.angleDeg * DEG;

  let state = {
    x: 0,
    y: launch.height,
    vx: launch.speed * Math.cos(angle),
    vy: launch.speed * Math.sin(angle),
    theta: angle,
    q: 0,
  };

  let t = 0;
  let sinceSample = CONFIG.sampleInterval;
  let maxHeight = state.y;
  let stalled = false;
  let stallTime = null;
  let endReason = "timeout";
  let lastAlpha = 0;
  let windSum = 0;
  let windCount = 0;
  let gustMax = 0;
  const samples = [];

  const noteWind = (velocity) => {
    windSum += velocity.x;
    windCount += 1;
    const gust = Math.hypot(velocity.x - windField.steady, velocity.y);
    if (gust > gustMax) gustMax = gust;
  };

  const windNow = windVelocity(windField, 0);
  const opening = aerodynamicDerivatives(state, plane, windNow.x, windNow.y);
  if (opening) lastAlpha = opening.alpha;

  const takeSample = (velocity) => {
    samples.push({
      t,
      x: state.x,
      y: state.y,
      vx: state.vx,
      vy: state.vy,
      theta: state.theta,
      q: state.q,
      alpha: lastAlpha,
      windX: velocity.x,
      windY: velocity.y,
    });
    sinceSample = 0;
  };

  while (t < CONFIG.maxFlightTime) {
    if (!finiteState(state)) {
      endReason = "nan";
      break;
    }
    if (state.y > maxHeight) maxHeight = state.y;
    const velocity = windVelocity(windField, t);
    if (sinceSample >= CONFIG.sampleInterval - 1e-9) takeSample(velocity);

    if (state.x > CONFIG.maxRange || state.y > CONFIG.maxAltitude || state.y < -1) {
      endReason = "out-of-bounds";
      break;
    }

    const stepped = stepState(state, plane, CONFIG.dt, velocity.x, velocity.y);
    if (!stepped) {
      endReason = "nan";
      break;
    }
    noteWind(velocity);
    if (stepped.stalled && !stalled) {
      stalled = true;
      stallTime = t;
    }

    if (stepped.state.y <= 0) {
      const hit = interpolateToGround(state, stepped.state);
      state = hit.state;
      t += hit.dt;
      lastAlpha = stepped.alpha;
      maxHeight = Math.max(maxHeight, state.y);
      endReason = "ground";
      const landed = windVelocity(windField, t);
      noteWind(landed);
      takeSample(landed);
      break;
    }

    state = stepped.state;
    lastAlpha = stepped.alpha;
    t += CONFIG.dt;
    sinceSample += CONFIG.dt;
  }

  if (samples.length === 0 || samples[samples.length - 1].t < t - 1e-6) {
    if (finiteState(state)) takeSample(windVelocity(windField, t));
  }

  const distance = Number.isFinite(state.x) ? state.x : 0;

  return {
    distance,
    flightTime: t,
    maxHeight,
    endReason,
    stalled,
    stallTime,
    samples,
    plane,
    launch,
    wind: {
      mode: windField.mode,
      seed: windField.seed,
      steady: windField.steady,
      gustMax,
      avg: windCount > 0 ? windSum / windCount : windField.steady,
      phases: windField.phases,
    },
  };
}
