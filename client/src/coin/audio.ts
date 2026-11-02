/**
 * Small WebAudio synth for the coin: a thumb-flick snap and metallic rings
 * on impact, loudness scaled by impact speed. Nothing plays until the user
 * turns sound on, which also unlocks audio in the browser.
 */

let context: AudioContext | null = null;

function audio() {
  if (!context) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
  }
  if (context.state === "suspended") void context.resume();
  return context;
}

/** Call from a click handler so the browser lets audio play later. */
export function unlockAudio() {
  audio();
}

function noiseBuffer(ctx: AudioContext, seconds: number) {
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** The snap of a thumbnail flicking the coin. */
export function playFlick(strength = 1) {
  const ctx = audio();
  if (!ctx) return;
  const now = ctx.currentTime;
  const out = ctx.createGain();
  out.connect(ctx.destination);

  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(ctx, 0.05);
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 3200;
  band.Q.value = 1.2;
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.35 * strength, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
  noise.connect(band).connect(noiseGain).connect(out);
  noise.start(now);

  // A short ring as the coin leaves the thumb.
  ring(ctx, out, now, 0.12 * strength, 2600, 0.35);
}

/** A metallic hit on the table. `speed` is the simulated impact speed. */
export function playImpact(speed: number) {
  const ctx = audio();
  if (!ctx) return;
  const level = Math.min(1, Math.max(0.04, (speed - 0.6) / 10));
  const now = ctx.currentTime;
  const out = ctx.createGain();
  out.connect(ctx.destination);

  // Thud of the table.
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(ctx, 0.06);
  const low = ctx.createBiquadFilter();
  low.type = "lowpass";
  low.frequency.value = 500;
  const thud = ctx.createGain();
  thud.gain.setValueAtTime(0.5 * level, now);
  thud.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
  noise.connect(low).connect(thud).connect(out);
  noise.start(now);

  ring(ctx, out, now, 0.22 * level, 1900 + Math.random() * 300, 0.25 + 0.6 * level);
}

/** Inharmonic partials of a struck disc, each decaying faster than the last. */
function ring(ctx: AudioContext, out: AudioNode, at: number, level: number, base: number, length: number) {
  [1, 2.32, 4.25, 6.63].forEach((ratio, index) => {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = base * ratio;
    const gain = ctx.createGain();
    const decay = length / (1 + index * 0.9);
    gain.gain.setValueAtTime(level / (1 + index), at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    osc.connect(gain).connect(out);
    osc.start(at);
    osc.stop(at + decay + 0.02);
  });
}
