import { useEffect, useRef, useState } from "react";
import { api, type CoinFlipState } from "./api";

type Face = "heads" | "tails" | "edge";

const VERT = `
attribute vec3 aPos;
attribute vec3 aColor;
attribute vec2 aUv;
uniform mat4 uMvp;
varying vec3 vColor;
varying vec2 vUv;
void main() {
  vColor = aColor;
  vUv = aUv;
  gl_Position = uMvp * vec4(aPos, 1.0);
}
`;

const FRAG = `
precision mediump float;
varying vec3 vColor;
varying vec2 vUv;
uniform sampler2D uTex;
void main() {
  if (vUv.x < 0.0) {
    gl_FragColor = vec4(vColor, 1.0);
  } else {
    gl_FragColor = texture2D(uTex, vUv);
  }
}
`;

type LandingStyle = "bounce" | "spin";

type Shot = {
  id: number;
  face: Face;
  style: LandingStyle;
};

export function CoinFlipPanel({ page = false }: { page?: boolean }) {
  const [open, setOpen] = useState(page);
  const [state, setState] = useState<CoinFlipState | null>(null);
  const [error, setError] = useState("");
  const [shot, setShot] = useState<Shot | null>(null);
  const [caption, setCaption] = useState("Waiting for the window.");
  const [now, setNow] = useState(() => Date.now());
  const playedWindow = useRef<string | null>(null);
  const picked = useRef<Face | null>(null);

  useEffect(() => {
    if (!page && !open) return;
    let stop = false;
    async function load() {
      try {
        const next = await api.coinFlip();
        if (stop) return;
        setState((current) => {
          if (picked.current && next.myOption !== picked.current && next.status !== "settled") {
            return { ...next, myOption: picked.current };
          }
          picked.current = (next.myOption as Face | null) ?? picked.current;
          return current?.startsAt === next.startsAt && current.myOption === next.myOption && current.counts.heads === next.counts.heads && current.counts.tails === next.counts.tails && current.counts.edge === next.counts.edge
            ? current
            : next;
        });
        setError("");
        const closed = new Date(next.closesAt).getTime() <= Date.now();
        if (!closed || playedWindow.current === next.startsAt) return;
        if (next.winningOptionId) {
          playedWindow.current = next.startsAt;
          setCaption(`Window closed. Landing on ${next.winningOptionId}.`);
          setShot({ id: Date.now(), face: next.winningOptionId, style: Math.random() < 0.55 ? "bounce" : "spin" });
        } else if (!next.sideBetId) {
          playedWindow.current = next.startsAt;
          const face = previewFace();
          setCaption(`No stakes. Preview landing on ${face}.`);
          setShot({ id: Date.now(), face, style: Math.random() < 0.55 ? "bounce" : "spin" });
        }
      } catch (err) {
        if (!stop) setError(err instanceof Error ? err.message : "Coin flip unavailable");
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 2000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [open, page]);

  useEffect(() => {
    if (!page && !open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [open, page]);

  async function stake(optionId: Face) {
    setError("");
    picked.current = optionId;
    setState((current) => {
      if (!current) return current;
      const previous = current.myOption as Face | null;
      const counts = { ...current.counts };
      if (previous && previous !== optionId) counts[previous] = Math.max(0, counts[previous] - 1);
      if (previous !== optionId) counts[optionId] += 1;
      return { ...current, myOption: optionId, counts };
    });
    setCaption(`You picked ${optionId}. 1 credit.`);
    try {
      const next = await api.stakeCoinFlip(optionId);
      picked.current = (next.myOption as Face | null) ?? optionId;
      setState(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Stake failed");
    }
  }

  const closesIn = state ? Math.max(0, new Date(state.closesAt).getTime() - now) : 0;
  const betting = Boolean(state) && closesIn > 10_000 && state?.status !== "settled";

  const board = (
          <section className={page ? "coin-modal coin-page" : "coin-modal"} onClick={(event) => event.stopPropagation()}>
            <header className="coin-modal-header">
              <h2>Live coin flip</h2>
              {page ? null : (
                <button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="Close">
                  ×
                </button>
              )}
            </header>
            <CoinCanvas shot={shot} restFace={state?.startFace ?? "heads"} />
            <Countdown remainingMs={closesIn} />
            <p className="muted">{caption}</p>
            <p className="muted">
              Stake is 1 credit. Bets lock with 10 seconds left. A coin flip is saved only after someone stakes.
            </p>
            <p className="muted">
              Starts {state?.startFace ?? "…"}. Same face about 51% (Diaconis). Edge about 1 in 6,000 (Murray and Teare).
            </p>
            <div className="coin-stakes">
              {(["heads", "tails", "edge"] as Face[]).map((face) => {
                const selected = state?.myOption === face;
                return (
                  <button
                    key={face}
                    type="button"
                    className={selected ? "coin-choice is-selected" : "coin-choice"}
                    disabled={!betting}
                    onClick={() => void stake(face)}
                  >
                    <span>{face}</span>
                    <strong>{state?.counts[face] ?? 0}</strong>
                    {selected ? <em>Selected</em> : <em>1 credit</em>}
                  </button>
                );
              })}
            </div>
            {state?.winningOptionId ? <p>Landed on {state.winningOptionId}.</p> : null}
            {!state?.sideBetId && !betting ? <p className="muted">No stakes this round, so nothing was recorded.</p> : null}
            {error ? <p className="form-error">{error}</p> : null}
          </section>
  );

  if (page) return board;

  return (
    <>
      <button className="secondary-button" type="button" onClick={() => setOpen(true)}>
        Coin flip
      </button>
      {open ? (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          {board}
        </div>
      ) : null}
    </>
  );
}

function Countdown({ remainingMs }: { remainingMs: number }) {
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const locked = totalSeconds <= 10;

  const urgent = totalSeconds <= 30;

  return (
    <div className={`coin-countdown${urgent ? " is-urgent" : ""}${locked ? " is-locked" : ""}`} aria-live="polite">
      <strong>
        {minutes}:{String(seconds).padStart(2, "0")}
      </strong>
      <span>{locked ? "Bets locked" : "Next flip"}</span>
    </div>
  );
}

function previewFace(): Face {
  const roll = Math.random();
  if (roll < 1 / 6000) return "edge";
  return roll < 0.51 ? "heads" : "tails";
}

function CoinCanvas({ shot, restFace }: { shot: Shot | null; restFace: Face }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const shotRef = useRef(shot);
  const restRef = useRef(restFace);
  shotRef.current = shot;
  restRef.current = restFace;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { antialias: true, alpha: true });
    if (!gl) return;

    const program = createProgram(gl, VERT, FRAG);
    gl.useProgram(program);
    const coin = buildCoin();
    const table = buildTable();
    const coinBuffer = gl.createBuffer();
    const tableBuffer = gl.createBuffer();
    const aPos = gl.getAttribLocation(program, "aPos");
    const aColor = gl.getAttribLocation(program, "aColor");
    const aUv = gl.getAttribLocation(program, "aUv");
    const uMvp = gl.getUniformLocation(program, "uMvp");
    const texture = createFaceTexture(gl);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(gl.getUniformLocation(program, "uTex"), 0);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.96, 0.95, 0.92, 1);

    let frame = 0;
    let activeId = 0;
    let startedAt = 0;

    const drawMesh = (buffer: WebGLBuffer | null, data: Float32Array, count: number, mvp: Float32Array) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 32, 0);
      gl.enableVertexAttribArray(aColor);
      gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 32, 12);
      gl.enableVertexAttribArray(aUv);
      gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 32, 24);
      gl.uniformMatrix4fv(uMvp, false, mvp);
      gl.drawArrays(gl.TRIANGLES, 0, count);
    };

    const draw = (now: number) => {
      resize(canvas, gl);
      const current = shotRef.current;
      if (current && current.id !== activeId) {
        activeId = current.id;
        startedAt = now;
      }
      const elapsed = current && startedAt ? (now - startedAt) / 1000 : 99;
      const pose = current ? poseAt(elapsed, current.face, current.style) : restPose(restRef.current);
      const aspect = canvas.width / Math.max(1, canvas.height);
      const view = followView(pose.y);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      drawMesh(tableBuffer, table.data, table.count, multiply(projection(aspect), view));
      drawMesh(coinBuffer, coin.data, coin.count, multiply(projection(aspect), multiply(view, coinModel(pose))));
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return <canvas ref={canvasRef} className="coin-canvas" aria-label="Coin flip" />;
}

type Pose = { y: number; flip: number; yaw: number; tilt: number };

function restPose(face: Face): Pose {
  return placeOnTable(0, faceAngle(face), 0.4, face === "edge" ? 0 : 0.08);
}

function faceAngle(face: Face) {
  if (face === "tails") return Math.PI;
  if (face === "edge") return Math.PI / 2;
  return 0;
}

function poseAt(t: number, face: Face, style: LandingStyle): Pose {
  const finalFlip = faceAngle(face) + Math.PI * 8;
  const rise = 2.6;
  let lift = 0;
  let flip = 0.2;
  let yaw = 0.35;
  let tilt = 0;

  if (t < 0.72) {
    const u = t / 0.72;
    lift = rise * Math.sin(u * Math.PI * 0.5);
    flip = finalFlip * 0.62 * easeOut(u);
    yaw = 0.35 + u * 0.8;
  } else if (t < 1.18) {
    const u = (t - 0.72) / 0.46;
    lift = rise * (1 - 0.04 * u);
    flip = finalFlip * (0.62 + 0.08 * u);
    yaw = 1.15 + u * 0.15;
    tilt = Math.sin(u * Math.PI) * 0.08;
  } else if (t < 1.72) {
    const u = (t - 1.18) / 0.54;
    lift = rise * (1 - u * u);
    flip = finalFlip * (0.7 + 0.18 * u);
    yaw = 1.3 + u * 1.4;
  } else if (style === "bounce") {
    const bounces = [0.7, 0.32, 0.12];
    const span = 0.42;
    const local = Math.min(t - 1.72, span * bounces.length);
    const index = Math.min(bounces.length - 1, Math.floor(local / span));
    const u = (local - index * span) / span;
    lift = bounces[index] * Math.sin(Math.max(0, Math.min(1, u)) * Math.PI);
    flip = finalFlip * (0.88 + 0.12 * Math.min(1, local / (span * bounces.length)));
    yaw = 2.7 + local * 0.4;
  } else {
    const u = Math.min(1, (t - 1.72) / 1.7);
    lift = 0.28 * Math.sin((1 - u) * Math.PI) * (1 - u);
    flip = finalFlip * (0.9 + 0.1 * easeOut(u));
    yaw = 2.7 + (1 - u) * (1 - u) * 7.5;
    tilt = face === "edge" ? (1 - u) * 0.25 : (1 - u) * 0.55;
  }

  if (t >= 3.5) {
    return placeOnTable(0, finalFlip, style === "spin" ? 2.7 : 2.7 + 0.42 * 3 * 0.4, 0);
  }
  return placeOnTable(lift, flip, yaw, tilt);
}

function placeOnTable(lift: number, flip: number, yaw: number, tilt: number): Pose {
  const radius = 1;
  const half = 0.08;
  const bottom = Math.hypot(half * Math.cos(flip), radius * Math.sin(flip));
  return { y: bottom + Math.abs(tilt) * 0.2 + lift, flip, yaw, tilt };
}

function easeOut(u: number) {
  return 1 - (1 - u) * (1 - u);
}

function resize(canvas: HTMLCanvasElement, gl: WebGLRenderingContext) {
  const width = canvas.clientWidth * devicePixelRatio;
  const height = canvas.clientHeight * devicePixelRatio;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  void gl;
}

function buildCoin() {
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const segments = 64;
  const radius = 1;
  const half = 0.08;
  const gold = [0.95, 0.78, 0.32];
  const rim = [0.55, 0.4, 0.12];

  for (let i = 0; i < segments; i += 1) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const x0 = Math.cos(a0) * radius;
    const z0 = Math.sin(a0) * radius;
    const x1 = Math.cos(a1) * radius;
    const z1 = Math.sin(a1) * radius;
    pushTri(positions, colors, uvs, [0, half, 0], [x1, half, z1], [x0, half, z0], gold, [0.25, 0.5], faceUv(x1, z1, 0.25), faceUv(x0, z0, 0.25));
    pushTri(positions, colors, uvs, [0, -half, 0], [x0, -half, z0], [x1, -half, z1], gold, [0.75, 0.5], faceUv(x0, z0, 0.75), faceUv(x1, z1, 0.75));
    pushTri(positions, colors, uvs, [x0, half, z0], [x0, -half, z0], [x1, -half, z1], rim, noUv, noUv, noUv);
    pushTri(positions, colors, uvs, [x0, half, z0], [x1, -half, z1], [x1, half, z1], gold, noUv, noUv, noUv);
  }

  return { data: interleave(positions, colors, uvs), count: positions.length / 3 };
}

const noUv: [number, number] = [-1, -1];

function faceUv(x: number, z: number, centerU: number): [number, number] {
  return [centerU + x * 0.22, 0.5 + z * 0.42];
}

function buildTable() {
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const top = [0.18, 0.22, 0.2];
  const edge = [0.1, 0.12, 0.11];
  const blank: [number, number] = [-1, -1];
  pushTri(positions, colors, uvs, [-4, 0, -4], [4, 0, -4], [4, 0, 4], top, blank, blank, blank);
  pushTri(positions, colors, uvs, [-4, 0, -4], [4, 0, 4], [-4, 0, 4], top, blank, blank, blank);
  pushTri(positions, colors, uvs, [-4, -0.18, 4], [4, -0.18, 4], [4, 0, 4], edge, blank, blank, blank);
  pushTri(positions, colors, uvs, [-4, -0.18, 4], [4, 0, 4], [-4, 0, 4], edge, blank, blank, blank);
  return { data: interleave(positions, colors, uvs), count: positions.length / 3 };
}

function pushTri(
  positions: number[],
  colors: number[],
  uvs: number[],
  a: number[],
  b: number[],
  c: number[],
  color: number[],
  uvA: [number, number],
  uvB: [number, number],
  uvC: [number, number]
) {
  const points = [a, b, c];
  const uv = [uvA, uvB, uvC];
  points.forEach((point, index) => {
    positions.push(point[0], point[1], point[2]);
    colors.push(color[0], color[1], color[2]);
    uvs.push(uv[index][0], uv[index][1]);
  });
}

function interleave(positions: number[], colors: number[], uvs: number[]) {
  const out = new Float32Array((positions.length / 3) * 8);
  for (let i = 0, v = 0, u = 0; i < positions.length; i += 3, v += 8, u += 2) {
    out[v] = positions[i];
    out[v + 1] = positions[i + 1];
    out[v + 2] = positions[i + 2];
    out[v + 3] = colors[i];
    out[v + 4] = colors[i + 1];
    out[v + 5] = colors[i + 2];
    out[v + 6] = uvs[u];
    out[v + 7] = uvs[u + 1];
  }
  return out;
}

function createFaceTexture(gl: WebGLRenderingContext) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("texture");
  paintFace(ctx, 0, "H", "#8a5a12", "#f6d98a");
  paintFace(ctx, 256, "T", "#6d4a10", "#e7c56a");
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

function paintFace(ctx: CanvasRenderingContext2D, x: number, letter: string, ink: string, metal: string) {
  ctx.fillStyle = metal;
  ctx.fillRect(x, 0, 256, 256);
  ctx.beginPath();
  ctx.arc(x + 128, 128, 108, 0, Math.PI * 2);
  ctx.fillStyle = "#f3e2a8";
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = ink;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + 128, 128, 86, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = ink;
  ctx.font = "700 132px Georgia, serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(letter, x + 128, 136);
}

function projection(aspect: number) {
  const f = 1 / Math.tan((38 * Math.PI) / 360);
  const near = 0.1;
  const far = 30;
  const p = new Float32Array(16);
  p[0] = f / aspect;
  p[5] = f;
  p[10] = (far + near) / (near - far);
  p[11] = -1;
  p[14] = (2 * far * near) / (near - far);
  return p;
}

function followView(coinY: number) {
  const eyeY = 5.6 + coinY * 0.15;
  return lookAt([0.2, eyeY, 2.4], [0, Math.min(coinY, 0.8), 0], [0, 0, -1]);
}

function coinModel(pose: Pose) {
  return multiply(translate(0, pose.y, 0), multiply(rotateY(pose.yaw), multiply(rotateX(pose.flip), rotateZ(pose.tilt))));
}

function lookAt(eye: number[], target: number[], up: number[]) {
  const zAxis = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const xAxis = normalize(cross(up, zAxis));
  const yAxis = cross(zAxis, xAxis);
  const m = identity();
  m[0] = xAxis[0];
  m[1] = yAxis[0];
  m[2] = zAxis[0];
  m[4] = xAxis[1];
  m[5] = yAxis[1];
  m[6] = zAxis[1];
  m[8] = xAxis[2];
  m[9] = yAxis[2];
  m[10] = zAxis[2];
  m[12] = -dot(xAxis, eye);
  m[13] = -dot(yAxis, eye);
  m[14] = -dot(zAxis, eye);
  return m;
}

function cross(a: number[], b: number[]) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: number[], b: number[]) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(v: number[]) {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function translate(x: number, y: number, z: number) {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

function rotateX(angle: number) {
  const m = identity();
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  m[5] = c;
  m[6] = s;
  m[9] = -s;
  m[10] = c;
  return m;
}

function rotateY(angle: number) {
  const m = identity();
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
}

function rotateZ(angle: number) {
  const m = identity();
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  m[0] = c;
  m[1] = s;
  m[4] = -s;
  m[5] = c;
  return m;
}

function identity() {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

function multiply(a: Float32Array, b: Float32Array) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[col * 4 + row] =
        a[row] * b[col * 4] +
        a[4 + row] * b[col * 4 + 1] +
        a[8 + row] * b[col * 4 + 2] +
        a[12 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

function createProgram(gl: WebGLRenderingContext, vert: string, frag: string) {
  const program = gl.createProgram();
  if (!program) throw new Error("webgl");
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vert));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(program);
  return program;
}

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}
