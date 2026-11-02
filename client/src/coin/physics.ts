/**
 * A real rigid-disc simulation of a coin toss, used to choose a flick that
 * lands on a known result.
 *
 * The coin is simulated in its spin plane: horizontal position `x`, height
 * `y`, and rotation `theta` about a diameter. In that plane its cross-section
 * is a 2R x 2H rectangle, so contact with the table is checked at the four
 * rim corners, with gravity, restitution (lower at low speed) and Coulomb
 * friction. Sideways drift and wobble are visual only and handled by the scene.
 *
 * Outcome control is rejection sampling: simulate random realistic flicks
 * fully, bounces included, and keep the first that comes to rest on the
 * wanted face near the middle of the table. The face is never corrected.
 * Edge landings are too rare to find that way, so `findEdge` bisects flick
 * strength between a heads flick and a tails flick until one balances.
 *
 * theta convention: 0 = heads up, PI = tails up, +-PI/2 = standing on edge.
 * The face normal in the plane is (-sin theta, cos theta).
 */

export type Face = "heads" | "tails" | "edge";

export const RADIUS = 1;
export const HALF_THICKNESS = 0.075;

/** Scene-scale gravity. Tuned so a toss hangs for about a second and a half. */
export const GRAVITY = 22;
const MASS = 1;
/** Disc rotating about a diameter. */
const INERTIA = MASS * ((RADIUS * RADIUS) / 4 + (2 * HALF_THICKNESS) ** 2 / 12);
const FRICTION = 0.35;
const RESTITUTION = 0.5;
/** Below IMPACT_LOW the coin does not bounce; restitution ramps up to IMPACT_HIGH. */
const IMPACT_LOW = 0.6;
const IMPACT_HIGH = 3;
const DT = 1 / 480;
const ITERATIONS = 8;
export const RECORD_EVERY = 4;
export const RECORD_DT = DT * RECORD_EVERY;
/** sin(3 degrees): how far from upright still counts as balanced on the edge. */
const EDGE_TOLERANCE = Math.sin((3 * Math.PI) / 180);
const EDGE_HOLD = 1.1;

export type Flick = {
  /** Upward launch speed. */
  vy: number;
  /** Speed along the spin plane. */
  vx: number;
  /** Spin rate, rad/s. Sign is the spin direction. */
  w: number;
  theta0: number;
  x0: number;
};

export type Impact = { t: number; speed: number };

export type Track = {
  x: Float32Array;
  y: Float32Array;
  theta: Float32Array;
  frames: number;
  duration: number;
  impacts: Impact[];
  /** Time of first touchdown; airborne-only effects fade before this. */
  firstImpact: number;
  face: Face;
  finalX: number;
  flick: Flick;
};

export function restHeight(theta: number) {
  return RADIUS * Math.abs(Math.sin(theta)) + HALF_THICKNESS * Math.abs(Math.cos(theta));
}

const SX = [1, 1, -1, -1];
const SY = [1, -1, 1, -1];

export function simulate(flick: Flick, maxTime = 12): Track {
  let x = flick.x0;
  let theta = flick.theta0;
  let y = restHeight(theta) + 1e-4;
  let vx = flick.vx;
  let vy = flick.vy;
  let w = flick.w;

  const steps = Math.ceil(maxTime / DT);
  const capacity = Math.ceil(steps / RECORD_EVERY) + 2;
  const xs = new Float32Array(capacity);
  const ys = new Float32Array(capacity);
  const ts = new Float32Array(capacity);
  let frames = 0;
  const impacts: Impact[] = [];
  let firstImpact = -1;
  let still = 0;
  let upright = 0;
  let face: Face | null = null;

  const ru = [0, 0, 0, 0];
  const rv = [0, 0, 0, 0];
  const target = [0, 0, 0, 0];
  const jn = [0, 0, 0, 0];
  const jt = [0, 0, 0, 0];
  const active = [false, false, false, false];

  const record = () => {
    xs[frames] = x;
    ys[frames] = y;
    ts[frames] = theta;
    frames += 1;
  };
  record();

  let step = 0;
  for (; step < steps; step += 1) {
    const t = step * DT;
    vy -= GRAVITY * DT;
    x += vx * DT;
    y += vy * DT;
    theta += w * DT;

    const c = Math.cos(theta);
    const s = Math.sin(theta);
    let deepest = 0;
    let touching = false;
    let hardest = 0;
    for (let k = 0; k < 4; k += 1) {
      ru[k] = RADIUS * SX[k] * c - HALF_THICKNESS * SY[k] * s;
      rv[k] = RADIUS * SX[k] * s + HALF_THICKNESS * SY[k] * c;
      const py = y + rv[k];
      active[k] = py < 0;
      jn[k] = 0;
      jt[k] = 0;
      if (!active[k]) continue;
      touching = true;
      deepest = Math.max(deepest, -py);
      const vn = vy + w * ru[k];
      const speed = -vn;
      const e = speed <= IMPACT_LOW ? 0 : speed >= IMPACT_HIGH ? RESTITUTION : (RESTITUTION * (speed - IMPACT_LOW)) / (IMPACT_HIGH - IMPACT_LOW);
      target[k] = vn < 0 ? -e * vn : 0;
      hardest = Math.max(hardest, speed);
    }

    if (touching) {
      if (firstImpact < 0) firstImpact = t;
      if (hardest > 0.8) {
        const last = impacts[impacts.length - 1];
        if (last && t - last.t < 0.05) last.speed = Math.max(last.speed, hardest);
        else impacts.push({ t, speed: hardest });
      }

      for (let iter = 0; iter < ITERATIONS; iter += 1) {
        for (let k = 0; k < 4; k += 1) {
          if (!active[k]) continue;
          // Normal impulse along +y. r x n = ru.
          const vn = vy + w * ru[k];
          const kn = 1 / MASS + (ru[k] * ru[k]) / INERTIA;
          const nextN = Math.max(0, jn[k] + (target[k] - vn) / kn);
          const dn = nextN - jn[k];
          jn[k] = nextN;
          vy += dn / MASS;
          w += (ru[k] * dn) / INERTIA;

          // Coulomb friction along +x. r x t = -rv.
          const vt = vx - w * rv[k];
          const kt = 1 / MASS + (rv[k] * rv[k]) / INERTIA;
          const limit = FRICTION * jn[k];
          const nextT = Math.min(limit, Math.max(-limit, jt[k] - vt / kt));
          const dt = nextT - jt[k];
          jt[k] = nextT;
          vx += dt / MASS;
          w -= (rv[k] * dt) / INERTIA;
        }
      }
      // Push out of the table, and a little rolling resistance while in contact.
      y += deepest;
      w *= 1 - 0.8 * DT;
    }

    if ((step + 1) % RECORD_EVERY === 0) record();

    // ---- has it come to rest? ----
    const up = Math.cos(theta);
    const calm = touching && Math.abs(vx) < 0.04 && Math.abs(vy) < 0.05 && Math.abs(w) < 0.06;
    still = calm ? still + DT : 0;
    upright = touching && Math.abs(up) < EDGE_TOLERANCE ? upright + DT : 0;
    if (still > 0.3 && Math.abs(up) > 0.95) {
      face = up > 0 ? "heads" : "tails";
      break;
    }
    if (upright > EDGE_HOLD && Math.abs(w) < 0.06) {
      face = "edge";
      break;
    }
  }

  if (!face) {
    const up = Math.cos(theta);
    face = Math.abs(up) < EDGE_TOLERANCE ? "edge" : up > 0 ? "heads" : "tails";
  }
  record();

  return {
    x: xs,
    y: ys,
    theta: ts,
    frames,
    duration: (frames - 1) * RECORD_DT,
    impacts,
    firstImpact: firstImpact < 0 ? (frames - 1) * RECORD_DT : firstImpact,
    face,
    finalX: x,
    flick
  };
}

export type FlickRange = { minHeight: number; maxHeight: number; minRatio: number; maxRatio: number };

/** A proper toss: about three turns in the air. */
export const TOSS: FlickRange = { minHeight: 3.4, maxHeight: 6.2, minRatio: 0.55, maxRatio: 0.85 };

/**
 * A random, realistic flick straight off the table. Spin is capped at
 * ratio * vy / R with ratio < 1, so the trailing rim rises with the coin
 * instead of swinging down into the table.
 */
function randomFlick(rand: () => number, theta0: number, x0: number, range: FlickRange, height?: number): Flick {
  const h = height ?? range.minHeight + (range.maxHeight - range.minHeight) * rand();
  const vy = Math.sqrt(2 * GRAVITY * h);
  const ratio = range.minRatio + (range.maxRatio - range.minRatio) * rand();
  const direction = rand() < 0.5 ? -1 : 1;
  // Drift a little, leaning back toward the middle of the table.
  const vx = (rand() - 0.5) * 1.0 - x0 * 0.35;
  return { vy, vx, w: (direction * ratio * vy) / RADIUS, theta0, x0 };
}

/** How far from the middle (along the spin plane) a landing may finish. */
const CENTRE = 0.7;

/** Rejection sampling: the first simulated flick that rests on `face` near the middle. */
export function findLanding(face: Exclude<Face, "edge">, theta0: number, x0: number, range: FlickRange, rand = Math.random): Track {
  let fallback: Track | null = null;
  let last: Track | null = null;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const track = simulate(randomFlick(rand, theta0, x0, range));
    last = track;
    if (track.face !== face) continue;
    if (Math.abs(track.finalX) < CENTRE) return track;
    fallback ??= track;
  }
  if (fallback) return fallback;
  // Practically unreachable; still never fake the face.
  return last as Track;
}

/**
 * Edge landings are too rare to sample, so fix a flick's spin and drift and
 * bisect its strength between a heads landing and a tails landing until it
 * comes to rest balanced on the rim. Returns null if nothing balances.
 */
export function findEdge(theta0: number, x0: number, rand = Math.random, budget = 2500): Track | null {
  let sims = 0;
  const run = (flick: Flick) => {
    sims += 1;
    return simulate(flick);
  };
  const centred = (track: Track) => Math.abs(track.finalX) < CENTRE * 1.6;

  while (sims < budget) {
    const base = randomFlick(rand, theta0, x0, TOSS);
    const ratio = Math.abs(base.w) / base.vy;
    const sign = Math.sign(base.w);
    const withHeight = (h: number): Flick => {
      const vy = Math.sqrt(2 * GRAVITY * h);
      return { ...base, vy, w: sign * ratio * vy };
    };

    const grid = 12;
    const heights: number[] = [];
    const faces: Face[] = [];
    for (let i = 0; i <= grid; i += 1) {
      const h = TOSS.minHeight + ((TOSS.maxHeight - TOSS.minHeight) * i) / grid;
      const track = run(withHeight(h));
      if (track.face === "edge" && centred(track)) return track;
      heights.push(h);
      faces.push(track.face);
    }

    for (let i = 0; i < grid && sims < budget; i += 1) {
      if (faces[i] === faces[i + 1] || faces[i] === "edge" || faces[i + 1] === "edge") continue;
      let lo = heights[i];
      let hi = heights[i + 1];
      const loFace = faces[i];
      for (let iter = 0; iter < 40 && sims < budget; iter += 1) {
        const mid = (lo + hi) / 2;
        const track = run(withHeight(mid));
        if (track.face === "edge") {
          if (centred(track)) return track;
          break;
        }
        if (track.face === loFace) lo = mid;
        else hi = mid;
      }
    }
  }
  return null;
}
