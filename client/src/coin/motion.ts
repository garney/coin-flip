import * as THREE from "three";
import { RECORD_DT, type Face, type Track } from "./physics";

export type { Face };
export { HALF_THICKNESS, RADIUS } from "./physics";

/**
 * What the panel wants the coin to do. The scene works out the transitions.
 * - rest: lying on `face` (flips over onto it if it is showing something else).
 * - lock: bets are locked; the coin waits on the table and the camera pulls back.
 * - wait: the window closed; keep rattling until the result arrives.
 * - land: the result is in; flick the coin and let physics land it on `face`.
 */
export type CoinPhase =
  | { kind: "rest"; face: Face }
  | { kind: "lock"; id: string; face: Face }
  | { kind: "wait"; id: string; face: Face }
  | { kind: "land"; id: string; face: Face; startFace: Face };

export type Pose = {
  yaw: number;
  flip: number;
  tilt: number;
  tiltDirection: number;
};

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;

export const LOCK_TIME = 10;

export function faceAngle(face: Face) {
  if (face === "tails") return Math.PI;
  if (face === "edge") return Math.PI / 2;
  return 0;
}

/** yaw about Y, then a tilt about a horizontal axis, then the flip about X. */
export function poseQuaternion(pose: Pose, out = new THREE.Quaternion()) {
  out.setFromAxisAngle(Y, pose.yaw);
  if (pose.tilt !== 0) {
    const axis = new THREE.Vector3(Math.cos(pose.tiltDirection), 0, Math.sin(pose.tiltDirection));
    out.multiply(new THREE.Quaternion().setFromAxisAngle(axis, pose.tilt));
  }
  return out.multiply(new THREE.Quaternion().setFromAxisAngle(X, pose.flip));
}

/**
 * While bets are locked the coin rattles on the table, harder as the close
 * nears. It stays in contact; nothing lifts off before the real flick.
 */
export function lockPose(t: number, flip: number, yaw: number): Pose {
  const urgency = Math.min(1, t / LOCK_TIME);
  const shake = urgency * urgency;
  return {
    yaw: yaw + 0.025 * shake * Math.sin(t * 47),
    flip: flip + 0.03 * shake * Math.sin(t * 61),
    tilt: 0,
    tiltDirection: 0
  };
}

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a: number) {
  return a - TAU * Math.round(a / TAU);
}

/**
 * A simulated toss plus visual-only extras: the coin yaws round and wobbles
 * (precesses) a little in the air, and both fade out before the first
 * touchdown so the simulated contact is what you see on the table.
 */
export type Playback = {
  track: Track;
  yaw0: number;
  yawDrift: number;
  wobble: number;
  /** Unit vector of the spin plane along the table. */
  dirX: number;
  dirZ: number;
  /** Where sim x = 0 sits in the world. */
  originX: number;
  originZ: number;
  lateral0: number;
  lateralSpeed: number;
};

const smooth = (u: number) => {
  const c = Math.min(1, Math.max(0, u));
  return c * c * (3 - 2 * c);
};

export function playbackPose(p: Playback, t: number) {
  const { track } = p;
  const f = Math.min(track.frames - 1, Math.max(0, t / RECORD_DT));
  const i = Math.floor(f);
  const j = Math.min(track.frames - 1, i + 1);
  const a = f - i;
  const x = track.x[i] + (track.x[j] - track.x[i]) * a;
  const y = track.y[i] + (track.y[j] - track.y[i]) * a;
  const theta = track.theta[i] + (track.theta[j] - track.theta[i]) * a;

  const air = track.firstImpact;
  const airborne = 1 - smooth((t - (air - 0.3)) / 0.3);
  const yaw = p.yaw0 + p.yawDrift * smooth(t / Math.max(0.2, air));
  const lateralTime = Math.min(t, air) + (t > air ? 0.12 * (1 - Math.exp(-(t - air) / 0.12)) : 0);
  const lateral = p.lateral0 + p.lateralSpeed * lateralTime;

  const pose: Pose = {
    yaw,
    // The sim measures theta the other way round from three's X rotation.
    flip: -theta,
    tilt: p.wobble * airborne * Math.min(1, t / 0.25),
    tiltDirection: t * 9
  };
  return {
    pose,
    position: {
      x: p.originX + p.dirX * x + p.dirZ * lateral,
      y,
      z: p.originZ + p.dirZ * x - p.dirX * lateral
    },
    done: t >= track.duration
  };
}
