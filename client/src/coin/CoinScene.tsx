import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { ContactShadows, Environment, Lightformer } from "@react-three/drei";
import * as THREE from "three";
import { playFlick, playImpact } from "./audio";
import {
  HALF_THICKNESS,
  LOCK_TIME,
  RADIUS,
  faceAngle,
  lockPose,
  playbackPose,
  poseQuaternion,
  wrapAngle,
  type CoinPhase,
  type Face,
  type Playback,
  type Pose
} from "./motion";
import { TOSS, findEdge, findLanding, type Track } from "./physics";

export type { CoinPhase, Face };

type Props = {
  phase: CoinPhase;
  sound: boolean;
  /** Called when a result toss comes to rest, with the phase id it landed for. */
  onLanded?: (id: string) => void;
};

export default function CoinScene(props: Props) {
  // The Canvas fills its parent, so the parent div owns the size.
  return (
    <div className="coin-canvas" aria-label="Coin flip" role="img">
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [0, 3.4, 4.6], fov: 38, near: 0.1, far: 40 }}
      gl={{ antialias: true, alpha: true, toneMapping: THREE.NeutralToneMapping }}
    >
      <ambientLight intensity={0.6} />
      <directionalLight position={[3, 6, 4]} intensity={1.6} />
      <Environment resolution={256}>
        <Lightformer form="rect" intensity={3} color="#fff4dc" position={[0, 6, 2]} scale={[8, 3, 1]} rotation-x={Math.PI / 2} />
        <Lightformer form="rect" intensity={1.6} color="#ffffff" position={[-5, 2, 1]} scale={[3, 6, 1]} rotation-y={Math.PI / 2} />
        <Lightformer form="rect" intensity={1.2} color="#ffd9a0" position={[5, 1, -2]} scale={[3, 6, 1]} rotation-y={-Math.PI / 2} />
        <Lightformer form="ring" intensity={2} color="#ffffff" position={[0, 3, -6]} scale={3} />
      </Environment>
      <ContactShadows position={[0, 0.002, 0]} opacity={0.55} scale={10} blur={2.4} far={4} resolution={512} color="#000000" />
      <Coin {...props} />
    </Canvas>
    </div>
  );
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** What the coin is doing right now, with the clock it started on. */
type Mode =
  | { kind: "rest" }
  | { kind: "lock"; id: string; start: number }
  | { kind: "play"; id: string; start: number; playback: Playback; nextImpact: number };

type SpringKey = "zoom" | "orbit" | "lookX" | "lookY" | "lookZ";

/**
 * Critically damped spring toward `target` (the well-known "SmoothDamp").
 * Velocity carries over between frames, so a change of target never makes
 * the value jump from still to full speed.
 */
function smoothDamp(current: number, target: number, velocities: Record<SpringKey, number>, key: SpringKey, smoothTime: number, dt: number) {
  const omega = 2 / smoothTime;
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (velocities[key] + omega * change) * dt;
  velocities[key] = (velocities[key] - omega * temp) * decay;
  return target + (change + temp) * decay;
}

/** Resting yaw at which the face art reads upright to the camera. */
const READABLE_YAW = 0.3;

function Coin({ phase, sound, onLanded }: Props) {
  const group = useRef<THREE.Group>(null);
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);
  const materials = useCoinMaterials();

  // Everything the animation needs lives in refs, so React renders never restart a motion.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const onLandedRef = useRef(onLanded);
  onLandedRef.current = onLanded;
  const mode = useRef<Mode>({ kind: "rest" });
  // The coin's resting state on the table.
  const rest = useRef({
    face: (phase.kind === "land" ? phase.startFace : phase.face) as Face,
    flip: faceAngle(phase.kind === "land" ? phase.startFace : phase.face),
    yaw: READABLE_YAW,
    x: 0,
    z: 0
  });
  const landedId = useRef<string | null>(null);
  const rig = useRef({
    zoom: 1,
    orbit: 0,
    lookX: 0,
    lookY: 0.05,
    lookZ: 0,
    vel: { zoom: 0, orbit: 0, lookX: 0, lookY: 0, lookZ: 0 },
    holding: false,
    holdZoom: 1,
    holdOrbit: 0,
    shake: 0,
    shakeAt: -10,
    landedAt: -10
  });

  // Drag-to-spin: yaw spins freely with inertia; pitch peeks and springs back.
  const drag = useRef({ active: false, x: 0, y: 0, yaw: 0, yawVel: 0, pitch: 0, pitchVel: 0 });
  const hovered = useRef(false);

  useEffect(() => {
    const up = () => {
      drag.current.active = false;
      gl.domElement.style.cursor = hovered.current ? "grab" : "";
    };
    const move = (event: PointerEvent) => {
      const d = drag.current;
      if (!d.active) return;
      const dx = event.clientX - d.x;
      const dy = event.clientY - d.y;
      d.x = event.clientX;
      d.y = event.clientY;
      d.yawVel = dx * 0.012;
      d.yaw += d.yawVel;
      d.pitchVel = dy * 0.01;
      d.pitch = THREE.MathUtils.clamp(d.pitch + d.pitchVel, -1.2, 1.2);
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointermove", move);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointermove", move);
    };
  }, [gl]);

  const q = useMemo(() => new THREE.Quaternion(), []);
  const extra = useMemo(() => new THREE.Quaternion(), []);
  const euler = useMemo(() => new THREE.Euler(), []);
  const up = useMemo(() => new THREE.Vector3(), []);

  /**
   * Simulate flicks from where the coin lies until one lands on `face`, and
   * wrap it with the visual extras. Edge uses the bisection search; if that
   * finds nothing the caller falls back to a plain toss.
   */
  const planFlick = (face: Face): Playback | null => {
    const r = rest.current;
    // Spin plane along the coin's current facing.
    const yaw0 = r.yaw + drag.current.yaw;
    const dirX = Math.sin(yaw0);
    const dirZ = Math.cos(yaw0);
    const along = r.x * dirX + r.z * dirZ;
    const across = r.x * dirZ - r.z * dirX;
    const theta0 = wrapAngle(-r.flip);

    let track: Track | null = null;
    if (face === "edge") track = findEdge(theta0, along);
    if (!track) track = findLanding(face === "edge" ? "heads" : face, theta0, along, TOSS);
    if (face === "edge" && track.face !== "edge") return null;

    const air = Math.max(0.3, track.firstImpact);
    // Yaw round in the air to finish near a readable angle; the face is the simulation's.
    const yawDrift = wrapAngle(READABLE_YAW + (Math.random() - 0.5) * 0.6 - yaw0);
    return {
      track,
      yaw0,
      yawDrift,
      wobble: 0.08 + Math.random() * 0.08,
      dirX,
      dirZ,
      originX: r.x - dirX * along,
      originZ: r.z - dirZ * along,
      lateral0: across,
      // Sideways drift leans back toward the middle so tosses never wander off.
      lateralSpeed: (-across * 0.9 + (Math.random() - 0.5) * 0.3) / air
    };
  };

  useFrame((state, delta) => {
    const g = group.current;
    if (!g) return;
    const now = state.clock.elapsedTime;
    const d = drag.current;
    const want = phaseRef.current;
    const reduce = reducedMotion();
    const r = rest.current;

    const startPlay = (id: string, face: Face) => {
      const playback = planFlick(face);
      if (!playback) return false;
      d.yaw = 0;
      d.yawVel = 0;
      d.active = false;
      mode.current = { kind: "play", id, start: now, playback, nextImpact: 0 };
      if (soundRef.current && !reduce) playFlick();
      return true;
    };

    // ---- transitions ----
    const m = mode.current;
    // Once a toss lands the coin stays exactly as it fell: no hop back to a
    // starting face, no nudge on picks. The next toss starts from where it lies.
    if ((want.kind === "lock" || want.kind === "wait") && m.kind === "rest" && landedId.current !== want.id) {
      mode.current = { kind: "lock", id: want.id, start: now - (want.kind === "wait" ? LOCK_TIME : 0) };
    } else if (want.kind === "land" && landedId.current !== want.id && m.kind !== "play") {
      if (!startPlay(want.id, want.face)) {
        // No balancing flick found: fall back to a face rather than fake an edge.
        startPlay(want.id, Math.random() < 0.5 ? "heads" : "tails");
      }
    } else if (want.kind === "rest" && m.kind === "lock") {
      mode.current = { kind: "rest" };
    }

    // ---- pose ----
    const current = mode.current;
    let pose: Pose;
    let position: { x: number; y: number; z: number } | null = null;
    if (current.kind === "play") {
      const t = reduce ? current.playback.track.duration : now - current.start;
      const frame = playbackPose(current.playback, t);
      pose = frame.pose;
      position = frame.position;
      // Sounds and camera shake from the simulated impacts.
      const impacts = current.playback.track.impacts;
      while (current.nextImpact < impacts.length && impacts[current.nextImpact].t <= t) {
        const hit = impacts[current.nextImpact];
        current.nextImpact += 1;
        if (reduce) continue;
        if (soundRef.current) playImpact(hit.speed);
        const strength = Math.min(1, hit.speed / 14);
        if (strength > rig.current.shake * Math.exp(-(now - rig.current.shakeAt) * 9)) {
          rig.current.shake = strength;
          rig.current.shakeAt = now;
        }
      }
      if (frame.done) {
        const track = current.playback.track;
        r.face = track.face;
        r.flip = wrapAngle(-track.theta[track.frames - 1]);
        r.yaw = pose.yaw;
        r.x = frame.position.x;
        r.z = frame.position.z;
        if (current.id) {
          landedId.current = current.id;
          rig.current.landedAt = now;
          onLandedRef.current?.(current.id);
        }
        mode.current = { kind: "rest" };
      }
    } else if (current.kind === "lock") {
      pose = lockPose(reduce ? 0 : now - current.start, r.flip, r.yaw);
    } else {
      pose = { yaw: r.yaw, flip: r.flip, tilt: 0, tiltDirection: 0 };
    }

    const interactive = mode.current.kind === "rest";
    if (interactive) {
      if (!d.active) {
        d.yaw += d.yawVel;
        d.yawVel *= Math.pow(0.04, delta); // inertia
        d.pitchVel = 0;
        d.pitch += (0 - d.pitch) * Math.min(1, delta * 8); // spring back flat
      }
    } else {
      d.active = false;
      d.yawVel = 0;
      d.pitch *= 0.85;
    }

    // Orientation = user's yaw/peek on top of the pose.
    poseQuaternion(pose, q);
    if (current.kind !== "play") {
      euler.set(d.pitch, d.yaw, 0, "YXZ");
      extra.setFromEuler(euler);
      q.premultiply(extra);
    }
    g.quaternion.copy(q);

    if (position) {
      g.position.set(position.x, position.y, position.z);
    } else {
      // Keep the lowest point of the coin on the table, whatever the angle.
      up.set(0, 1, 0).applyQuaternion(q);
      const ny = Math.min(1, Math.abs(up.y));
      const bottom = RADIUS * Math.sqrt(1 - ny * ny) + HALF_THICKNESS * ny;
      const hoverLift = interactive && hovered.current && !d.active ? 0.06 : 0;
      g.position.set(r.x, bottom + hoverLift, r.z);
    }

    // ---- camera ----
    // Lock: pull back slowly and circle round. Toss: rise with the coin and
    // come back down with it. Impacts: a shake scaled by how hard it hit.
    // Every camera value moves on a critically damped spring, so when a target
    // changes (lock starts, coin lands, the hold ends) the camera speeds up and
    // slows down smoothly instead of lurching.
    const cam = rig.current;
    const kind = mode.current.kind;
    const tossing = kind === "play";
    if (tossing && !cam.holding) {
      // Keep the wide shot from the lock through the toss and a moment after it lands.
      cam.holding = true;
      cam.holdZoom = Math.max(cam.zoom, 1.5);
      cam.holdOrbit = cam.orbit;
    }
    const holding = tossing || (kind === "rest" && now - cam.landedAt < 1.6 && cam.holding);
    if (!holding) cam.holding = false;
    let zoomTarget = 1;
    let orbitTarget = 0;
    if (mode.current.kind === "lock") {
      const u = Math.min(1, (now - mode.current.start) / LOCK_TIME);
      const eased = u * u * (3 - 2 * u);
      zoomTarget = 1 + 0.75 * eased;
      orbitTarget = -0.55 * eased;
    } else if (holding) {
      zoomTarget = cam.holdZoom;
      orbitTarget = cam.holdOrbit;
    }
    const step = Math.min(delta, 0.1);
    // Ease back in slowly after a toss; react quicker during the lock and toss.
    const easeBack = kind === "rest" ? 1.3 : 0.45;
    cam.zoom = smoothDamp(cam.zoom, zoomTarget, cam.vel, "zoom", easeBack, step);
    cam.orbit = smoothDamp(cam.orbit, orbitTarget, cam.vel, "orbit", easeBack, step);

    const shakeAge = now - cam.shakeAt;
    const shake = reduce ? 0 : 0.09 * cam.shake * Math.exp(-shakeAge * 9);

    // Follow the coin up and down; quicker in the air so it stays in frame.
    cam.lookY = smoothDamp(cam.lookY, g.position.y * 0.75, cam.vel, "lookY", tossing ? 0.16 : 0.4, step);
    // Centre on the coin: loosely in the air so the shot stays calm, fully once
    // it has landed so it is centred as the camera comes back in.
    const centring = tossing ? 0.5 : 1;
    const centreTime = tossing ? 0.5 : 0.8;
    cam.lookX = smoothDamp(cam.lookX, g.position.x * centring, cam.vel, "lookX", centreTime, step);
    cam.lookZ = smoothDamp(cam.lookZ, g.position.z * centring, cam.vel, "lookZ", centreTime, step);

    const distance = 4.6 * cam.zoom;
    const height = 3.4 * (0.75 + 0.25 * cam.zoom) + cam.lookY * 0.35;
    const lookX = cam.lookX;
    const lookZ = cam.lookZ;
    camera.position.set(
      lookX + Math.sin(cam.orbit) * distance + shake * Math.sin(now * 90),
      height + shake * Math.cos(now * 77),
      lookZ + Math.cos(cam.orbit) * distance
    );
    camera.lookAt(lookX, cam.lookY, lookZ);
  });

  const onPointerDown = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    const d = drag.current;
    d.active = true;
    d.x = event.clientX;
    d.y = event.clientY;
    d.yawVel = 0;
    gl.domElement.style.cursor = "grabbing";
  };

  return (
    <group
      ref={group}
      onPointerDown={onPointerDown}
      onPointerOver={() => {
        hovered.current = true;
        if (!drag.current.active) gl.domElement.style.cursor = "grab";
      }}
      onPointerOut={() => {
        hovered.current = false;
        if (!drag.current.active) gl.domElement.style.cursor = "";
      }}
    >
      {/* Cylinder material order: side, top (heads), bottom (tails). */}
      <mesh material={materials}>
        <cylinderGeometry args={[RADIUS, RADIUS, HALF_THICKNESS * 2, 96, 1]} />
      </mesh>
    </group>
  );
}

function useCoinMaterials() {
  const materials = useMemo(() => {
    const heads = faceTexture("H", "HEADS");
    // The bottom cap is seen after a half turn about X, so its art is turned to read upright.
    const tails = faceTexture("T", "TAILS", Math.PI);
    const reeds = reedTexture();
    const metal = { color: "#ffffff", metalness: 0.85, roughness: 0.3, envMapIntensity: 1.6 };
    return [
      new THREE.MeshStandardMaterial({ ...metal, color: "#e8b94a", bumpMap: reeds, bumpScale: 1.5, roughness: 0.4 }),
      new THREE.MeshStandardMaterial({ ...metal, map: heads.color, bumpMap: heads.bump, bumpScale: 1.2 }),
      new THREE.MeshStandardMaterial({ ...metal, map: tails.color, bumpMap: tails.bump, bumpScale: 1.2 })
    ];
  }, []);

  useEffect(
    () => () => {
      materials.forEach((material) => {
        material.map?.dispose();
        material.bumpMap?.dispose();
        material.dispose();
      });
    },
    [materials]
  );

  return materials;
}

const FACE_SIZE = 512;

/** Draws one coin face twice: a color map and a matching height map for the raised relief. */
function faceTexture(letter: string, word: string, rotation = 0) {
  const draw = (ctx: CanvasRenderingContext2D, mode: "color" | "bump") => {
    const s = FACE_SIZE;
    const c = s / 2;
    const raised = mode === "bump" ? "#ffffff" : "#ffe9a6";
    const field = mode === "bump" ? "#5a5a5a" : "#d9a23a";
    if (rotation) {
      ctx.translate(s / 2, s / 2);
      ctx.rotate(rotation);
      ctx.translate(-s / 2, -s / 2);
    }

    if (mode === "color") {
      const gradient = ctx.createRadialGradient(c * 0.8, c * 0.7, 10, c, c, c);
      gradient.addColorStop(0, "#f2c860");
      gradient.addColorStop(1, "#c28a28");
      ctx.fillStyle = gradient;
    } else {
      ctx.fillStyle = field;
    }
    ctx.fillRect(0, 0, s, s);

    // Raised outer rim.
    ctx.beginPath();
    ctx.arc(c, c, c - 4, 0, Math.PI * 2);
    ctx.arc(c, c, c - 34, 0, Math.PI * 2, true);
    ctx.fillStyle = raised;
    ctx.fill();

    // Beaded inner ring.
    ctx.fillStyle = raised;
    for (let i = 0; i < 72; i += 1) {
      const a = (i / 72) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(c + Math.cos(a) * (c - 52), c + Math.sin(a) * (c - 52), 5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Word around the top of the face.
    ctx.font = "700 40px Georgia, 'Times New Roman', serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const letters = word.split("");
    const spread = 0.17;
    letters.forEach((char, i) => {
      const a = -Math.PI / 2 + (i - (letters.length - 1) / 2) * spread;
      ctx.save();
      ctx.translate(c + Math.cos(a) * (c - 96), c + Math.sin(a) * (c - 96));
      ctx.rotate(a + Math.PI / 2);
      ctx.fillText(char, 0, 0);
      ctx.restore();
    });

    // Small stars at the bottom.
    [-0.22, 0, 0.22].forEach((offset) => star(ctx, c + Math.sin(offset) * (c - 96), c + Math.cos(offset) * (c - 96), 13));

    // Big centre letter.
    ctx.font = "700 230px Georgia, 'Times New Roman', serif";
    ctx.fillText(letter, c, c + 14);
  };

  return { color: canvasTexture((ctx) => draw(ctx, "color"), true), bump: canvasTexture((ctx) => draw(ctx, "bump"), false) };
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const radius = i % 2 === 0 ? r : r * 0.45;
    ctx.lineTo(x + Math.cos(a) * radius, y + Math.sin(a) * radius);
  }
  ctx.closePath();
  ctx.fill();
}

/** Vertical ridges for the milled edge. */
function reedTexture() {
  const texture = canvasTexture((ctx) => {
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, 1024, 16);
    ctx.fillStyle = "#ffffff";
    for (let x = 0; x < 1024; x += 8) ctx.fillRect(x, 0, 4, 16);
  }, false, 1024, 16);
  return texture;
}

function canvasTexture(paint: (ctx: CanvasRenderingContext2D) => void, srgb: boolean, width = FACE_SIZE, height = FACE_SIZE) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx) paint(ctx);
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 8;
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
