/**
 * Synthesised sound effects for 巨大デジタル金魚すくい (spec §110).
 *
 * There are no audio asset files. Every effect is built here from noise buffers,
 * filters, oscillators and envelopes, rendered sample-by-sample into an AudioBuffer.
 * Rendering is synchronous and happens ONCE per effect per AudioContext (see 'getSfx'),
 * so at run time playing a sound is just a throw-away AudioBufferSourceNode.
 *
 * The palette is deliberately festival-like — wet, wooden, slightly distant — and never
 * arcade (spec §111). Water sounds are filtered noise with a fast pitch-down; wooden
 * sounds are short resonant modes; the celebratory sounds are flute-ish FM in D minor
 * pentatonic so they sit inside the 祭囃子 ambience instead of fighting it.
 */

import { clamp, createRng } from '@/game/core/math';

export type SfxName =
  | 'poiEnter'
  | 'poiExit'
  | 'splashSmall'
  | 'splashBig'
  | 'capture'
  | 'captureRare'
  | 'poiTear'
  | 'poiBreak'
  | 'poiRespawn'
  | 'countdown'
  | 'start'
  | 'timeUp'
  | 'drop'
  | 'join'
  | 'resultFanfare'
  | 'bowlDrop';

export const SFX_NAMES: readonly SfxName[] = [
  'poiEnter',
  'poiExit',
  'splashSmall',
  'splashBig',
  'capture',
  'captureRare',
  'poiTear',
  'poiBreak',
  'poiRespawn',
  'countdown',
  'start',
  'timeUp',
  'drop',
  'join',
  'resultFanfare',
  'bowlDrop',
];

/** Buffer length per effect, in seconds. Explicit so the total cache size is predictable. */
const SFX_SECONDS: Record<SfxName, number> = {
  poiEnter: 0.42,
  poiExit: 0.62,
  splashSmall: 0.34,
  splashBig: 0.78,
  capture: 0.8,
  captureRare: 1.5,
  poiTear: 0.22,
  poiBreak: 1.0,
  poiRespawn: 0.24,
  countdown: 0.26,
  start: 0.5,
  timeUp: 2.4,
  drop: 0.34,
  join: 0.85,
  resultFanfare: 2.1,
  bowlDrop: 0.34,
};

/** Peak amplitude each effect is normalised to, so relative loudness is deliberate. */
const SFX_PEAK: Record<SfxName, number> = {
  poiEnter: 0.5,
  poiExit: 0.44,
  splashSmall: 0.55,
  splashBig: 0.86,
  capture: 0.8,
  captureRare: 0.88,
  poiTear: 0.5,
  poiBreak: 0.92,
  poiRespawn: 0.46,
  countdown: 0.62,
  start: 0.8,
  timeUp: 0.9,
  drop: 0.42,
  join: 0.6,
  resultFanfare: 0.82,
  bowlDrop: 0.55,
};

const TWO_PI = Math.PI * 2;

/** D minor pentatonic — the scale the whole installation sings in (§111). */
export const PENTATONIC_D_MINOR = [
  146.83, 174.61, 196.0, 220.0, 261.63, // D3 F3 G3 A3 C4
  293.66, 349.23, 392.0, 440.0, 523.25, // D4 F4 G4 A4 C5
  587.33, 698.46, 783.99, 880.0, 1046.5, // D5 F5 G5 A5 C6
  1174.66, 1396.91, 1567.98, 1760.0, 2093.0, // D6 F6 G6 A6 C7
] as const;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * Chamberlin state-variable filter, 2x oversampled.
 *
 * The naive one-sample form goes unstable above roughly sampleRate/6; running the
 * recursion twice per sample buys us the whole audible band, which the splash
 * sweeps genuinely need (they start around 3–4 kHz).
 */
export class StateVariableFilter {
  lp = 0;
  bp = 0;
  hp = 0;
  private readonly innerRate: number;

  constructor(sampleRate: number) {
    this.innerRate = sampleRate * 2;
  }

  /** Advances one input sample. Returns the band-pass output (the useful one here). */
  step(x: number, cutoffHz: number, q: number): number {
    const fc = clamp(cutoffHz, 18, this.innerRate * 0.22);
    const f = 2 * Math.sin((Math.PI * fc) / this.innerRate);
    const damp = clamp(1 / Math.max(q, 0.4), 0.02, 1.9);
    for (let i = 0; i < 2; i++) {
      this.lp += f * this.bp;
      this.hp = x - this.lp - damp * this.bp;
      this.bp += f * this.hp;
    }
    return this.bp;
  }

  reset(): void {
    this.lp = 0;
    this.bp = 0;
    this.hp = 0;
  }
}

/** One-pole low-pass, used for gentle body shaping and for pink-ish tilting. */
export class OnePole {
  private z = 0;

  constructor(private readonly sampleRate: number) {}

  step(x: number, cutoffHz: number): number {
    const a = 1 - Math.exp((-TWO_PI * clamp(cutoffHz, 5, this.sampleRate * 0.45)) / this.sampleRate);
    this.z += a * (x - this.z);
    return this.z;
  }

  reset(v = 0): void {
    this.z = v;
  }
}

/** A mono AudioBuffer filled with white noise. Seeded, so a render is reproducible. */
export function noiseBuffer(ctx: BaseAudioContext, seconds: number, seed = 0x9e3779b9): AudioBuffer {
  const length = Math.max(1, Math.floor(seconds * ctx.sampleRate));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const rng = createRng(seed);
  for (let i = 0; i < length; i++) data[i] = rng.next() * 2 - 1;
  return buffer;
}

/** Pink-ish noise (Paul Kellet's economy filter) written into 'out'. */
export function fillPinkNoise(out: Float32Array, seed = 0x51ed2701): void {
  const rng = createRng(seed);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < out.length; i++) {
    const white = rng.next() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    out[i] = (b0 + b1 + b2 + white * 0.1848) * 0.22;
  }
}

export interface AdsrOptions {
  attack: number;
  decay: number;
  /** Sustain LEVEL, 0..1. */
  sustain: number;
  release: number;
}

/**
 * Classic ADSR sampled at time 't', with note-off at 'duration'.
 * Total audible length is 'duration + release'.
 */
export function adsr(t: number, duration: number, env: AdsrOptions): number {
  if (t < 0) return 0;
  if (t < env.attack) {
    const a = env.attack > 0 ? t / env.attack : 1;
    return a * a * (3 - 2 * a); // smoothstep — a linear attack ticks on percussive material
  }
  if (t < env.attack + env.decay) {
    const d = env.decay > 0 ? (t - env.attack) / env.decay : 1;
    return 1 + (env.sustain - 1) * d;
  }
  if (t < duration) return env.sustain;
  if (t < duration + env.release) {
    const r = env.release > 0 ? (t - duration) / env.release : 1;
    return env.sustain * (1 - r) * (1 - r);
  }
  return 0;
}

/**
 * Percussive envelope: smoothstep attack, exponential body, hard fade-out at the end so
 * a truncated buffer can never click.
 */
function hitEnv(t: number, duration: number, attack: number, curve: number): number {
  if (t < 0 || t >= duration) return 0;
  const a = attack > 0 ? Math.min(1, t / attack) : 1;
  const atk = a * a * (3 - 2 * a);
  const body = Math.exp((-curve * t) / duration);
  const fade = Math.min(1, (duration - t) / Math.min(0.015, duration * 0.25));
  return atk * body * fade;
}

/** Exponential frequency sweep with a shaping exponent (1 = plain exponential). */
function sweep(from: number, to: number, u: number, shape: number): number {
  const k = Math.pow(clamp(u, 0, 1), shape);
  return from * Math.pow(to / from, k);
}

export interface BandpassSweepOptions {
  q?: number;
  /** >1 sweeps fast at the start (the classic splash pitch-down), <1 sweeps late. */
  shape?: number;
}

/**
 * Runs a resonant band-pass over 'data' in place while sweeping the centre frequency
 * from 'fromHz' to 'toHz' across the whole array, then renormalises.
 * This is the workhorse behind every water sound here.
 */
export function bandpassSweep(
  data: Float32Array,
  sampleRate: number,
  fromHz: number,
  toHz: number,
  q = 1.4,
  opts: BandpassSweepOptions = {},
): void {
  const svf = new StateVariableFilter(sampleRate);
  const shape = opts.shape ?? 1;
  const n = data.length;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const fc = sweep(fromHz, toHz, n > 1 ? i / (n - 1) : 0, shape);
    const v = svf.step(data[i], fc, q);
    data[i] = v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  if (peak > 1e-6) {
    const g = 1 / peak;
    for (let i = 0; i < n; i++) data[i] *= g;
  }
}

export interface BlipOptions {
  /** Seconds from the start of the target buffer. */
  start: number;
  duration: number;
  gain: number;
  freq: number;
  /** Ends here if given — a downward sweep reads sad, an upward one reads like a bubble. */
  endFreq?: number;
  /** Pitch sweep shape; >1 lands on the target frequency early. */
  freqShape?: number;
  /** FM modulator frequency ratio and index (index decays with 'fmDecay'). */
  fmRatio?: number;
  fmIndex?: number;
  fmDecay?: number;
  attack?: number;
  /** Exponential decay steepness over 'duration'. */
  curve?: number;
  vibratoHz?: number;
  vibratoCents?: number;
  /** 0..1 — adds band-passed breath noise around the note; what makes a flute a flute. */
  breath?: number;
  seed?: number;
}

/**
 * Adds one pitched voice (sine carrier, optional FM modulator, optional breath noise)
 * into 'data'. Everything from the capture ping to the 祭囃子 flute is built from this.
 */
export function pitchedBlip(data: Float32Array, sampleRate: number, o: BlipOptions): void {
  const start = Math.max(0, Math.floor(o.start * sampleRate));
  const len = Math.min(data.length - start, Math.floor(o.duration * sampleRate));
  if (len <= 0) return;

  const fmRatio = o.fmRatio ?? 0;
  const fmIndex = o.fmIndex ?? 0;
  const fmDecay = o.fmDecay ?? 3;
  const attack = o.attack ?? 0.004;
  const curve = o.curve ?? 4;
  const freqShape = o.freqShape ?? 1;
  const breath = o.breath ?? 0;
  const vibHz = o.vibratoHz ?? 0;
  const vibDepth = o.vibratoCents ?? 0;

  const rng = createRng(o.seed ?? 0x2545f491);
  const breathFilter = new StateVariableFilter(sampleRate);

  let carrierPhase = 0;
  let modPhase = 0;

  for (let i = 0; i < len; i++) {
    const t = i / sampleRate;
    const u = t / o.duration;
    let f = o.endFreq !== undefined ? sweep(o.freq, o.endFreq, u, freqShape) : o.freq;
    if (vibHz > 0 && vibDepth > 0) {
      // Vibrato fades in — an instant wobble sounds synthetic.
      const depth = Math.pow(2, (vibDepth / 1200) * Math.sin(TWO_PI * vibHz * t)) - 1;
      f *= 1 + depth * Math.min(1, t / 0.18);
    }

    modPhase += (TWO_PI * f * fmRatio) / sampleRate;
    const modEnv = fmIndex > 0 ? Math.exp(-fmDecay * t) : 0;
    const mod = fmIndex > 0 ? Math.sin(modPhase) * fmIndex * modEnv : 0;

    carrierPhase += (TWO_PI * f) / sampleRate;
    let v = Math.sin(carrierPhase + mod);

    if (breath > 0) {
      const n = rng.next() * 2 - 1;
      v += breathFilter.step(n, f * 2.1, 1.1) * breath * 0.55;
    }

    data[start + i] += v * hitEnv(t, o.duration, attack, curve) * o.gain;
  }
}

export interface NoiseBurstOptions {
  start: number;
  duration: number;
  gain: number;
  /** Band-pass centre at the start and at the end of the burst. */
  fromHz: number;
  toHz: number;
  q?: number;
  sweepShape?: number;
  attack?: number;
  curve?: number;
  /** 0..1 — granular amplitude modulation; this is what turns hiss into a fibre rip. */
  crackle?: number;
  /** 0..1 — mixes in unfiltered low body under the band, for weight. */
  body?: number;
  seed?: number;
}

/**
 * Renders a band-passed, enveloped noise burst and mixes it into 'data'.
 * The burst is peak-normalised before mixing so 'gain' means the same thing at any Q.
 */
export function addNoiseBurst(data: Float32Array, sampleRate: number, o: NoiseBurstOptions): void {
  const start = Math.max(0, Math.floor(o.start * sampleRate));
  const len = Math.min(data.length - start, Math.floor(o.duration * sampleRate));
  if (len <= 0) return;

  const scratch = new Float32Array(len);
  const rng = createRng(o.seed ?? 0x68bc21eb);
  const crackle = o.crackle ?? 0;
  const bodyMix = o.body ?? 0;
  const bodyFilter = new OnePole(sampleRate);

  // Granular gate: a new random level every ~1.1 ms gives the torn-paper texture.
  const grain = Math.max(1, Math.floor(sampleRate * 0.0011));
  let gate = 1;

  for (let i = 0; i < len; i++) {
    if (crackle > 0 && i % grain === 0) {
      const r = rng.next();
      gate = 1 - crackle + crackle * r * r * 2.2;
    }
    const n = rng.next() * 2 - 1;
    scratch[i] = n * (crackle > 0 ? gate : 1);
  }

  // Keep a low-passed copy of the raw noise for weight before the band-pass removes it.
  let body: Float32Array | null = null;
  if (bodyMix > 0) {
    body = new Float32Array(len);
    for (let i = 0; i < len; i++) body[i] = bodyFilter.step(scratch[i], 240);
  }

  bandpassSweep(scratch, sampleRate, o.fromHz, o.toHz, o.q ?? 1.3, { shape: o.sweepShape ?? 1 });

  const attack = o.attack ?? 0.002;
  const curve = o.curve ?? 5;
  let peak = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sampleRate;
    let v = scratch[i];
    if (body) v += body[i] * bodyMix * 3.2;
    v *= hitEnv(t, o.duration, attack, curve);
    scratch[i] = v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  if (peak < 1e-6) return;

  const g = o.gain / peak;
  for (let i = 0; i < len; i++) data[start + i] += scratch[i] * g;
}

/**
 * A struck wooden resonance: a click excites two or three short high-Q modes.
 * Wood is defined by how FAST it dies, not by its pitch.
 */
function addWoodHit(
  data: Float32Array,
  sampleRate: number,
  start: number,
  gain: number,
  modes: readonly { hz: number; decay: number; level: number }[],
  seed: number,
): void {
  addNoiseBurst(data, sampleRate, {
    start,
    duration: 0.012,
    gain: gain * 0.5,
    fromHz: 3200,
    toHz: 2200,
    q: 0.8,
    attack: 0.0004,
    curve: 7,
    seed,
  });
  for (let m = 0; m < modes.length; m++) {
    const mode = modes[m];
    addNoiseBurst(data, sampleRate, {
      start,
      duration: mode.decay,
      gain: gain * mode.level,
      fromHz: mode.hz,
      toHz: mode.hz * 0.94,
      q: 9,
      attack: 0.0005,
      curve: 6.5,
      seed: seed + m * 977,
    });
  }
}

/** Scatters small water ticks through a window — the tail of any real splash. */
function addDropletScatter(
  data: Float32Array,
  sampleRate: number,
  from: number,
  to: number,
  count: number,
  gain: number,
  seed: number,
): void {
  const rng = createRng(seed);
  for (let i = 0; i < count; i++) {
    const at = rng.range(from, to);
    const f = rng.range(900, 2600);
    pitchedBlip(data, sampleRate, {
      start: at,
      duration: 0.045,
      gain: gain * rng.range(0.35, 1),
      freq: f * 0.55,
      endFreq: f,
      freqShape: 0.45,
      attack: 0.001,
      curve: 8,
      seed: seed + i * 131,
    });
  }
}

/** Gentle asymmetric-free soft clip — tames the peaks without adding fizz. */
function softClip(data: Float32Array): void {
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    data[i] = Math.tanh(x * 1.15) * 0.92;
  }
}

function normalize(data: Float32Array, peak: number): void {
  let max = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > max) max = a;
  }
  if (max < 1e-6) return;
  const g = peak / max;
  for (let i = 0; i < data.length; i++) data[i] *= g;
}

/** 4 ms in / 12 ms out so no rendered buffer can ever click on a BufferSource. */
function applyEdgeFades(data: Float32Array, sampleRate: number): void {
  const inLen = Math.min(Math.floor(sampleRate * 0.004), data.length >> 1);
  const outLen = Math.min(Math.floor(sampleRate * 0.012), data.length >> 1);
  for (let i = 0; i < inLen; i++) data[i] *= i / inLen;
  for (let i = 0; i < outLen; i++) {
    data[data.length - 1 - i] *= i / outLen;
  }
}

// ---------------------------------------------------------------------------
// The effects themselves
// ---------------------------------------------------------------------------

/** A soft low plop: the paper disc breaking the surface tension. */
function renderPoiEnter(data: Float32Array, sr: number): void {
  // The whump of displaced water.
  pitchedBlip(data, sr, {
    start: 0.0,
    duration: 0.24,
    gain: 0.9,
    freq: 250,
    endFreq: 72,
    freqShape: 0.4,
    attack: 0.003,
    curve: 5.5,
    seed: 11,
  });
  // The surface itself giving way — brief, dark, no sizzle.
  addNoiseBurst(data, sr, {
    start: 0.0,
    duration: 0.09,
    gain: 0.5,
    fromHz: 1900,
    toHz: 480,
    q: 1.1,
    sweepShape: 0.5,
    attack: 0.002,
    curve: 6,
    body: 0.3,
    seed: 12,
  });
  addDropletScatter(data, sr, 0.06, 0.3, 4, 0.16, 13);
}

/** A wet lift: water sheeting off the paper. Rising band = something leaving the water. */
function renderPoiExit(data: Float32Array, sr: number): void {
  addNoiseBurst(data, sr, {
    start: 0.0,
    duration: 0.5,
    gain: 0.85,
    fromHz: 340,
    toHz: 2700,
    q: 1.0,
    sweepShape: 0.8,
    attack: 0.07,
    curve: 3.0,
    body: 0.18,
    seed: 21,
  });
  // Suction as the disc clears the surface.
  pitchedBlip(data, sr, {
    start: 0.02,
    duration: 0.16,
    gain: 0.3,
    freq: 130,
    endFreq: 300,
    freqShape: 0.7,
    attack: 0.02,
    curve: 4,
    seed: 22,
  });
  addDropletScatter(data, sr, 0.18, 0.58, 9, 0.2, 23);
}

function renderSplashSmall(data: Float32Array, sr: number): void {
  addNoiseBurst(data, sr, {
    start: 0.0,
    duration: 0.3,
    gain: 1.0,
    fromHz: 3300,
    toHz: 620,
    q: 1.2,
    sweepShape: 0.35, // most of the pitch-down happens in the first few milliseconds
    attack: 0.0015,
    curve: 6.5,
    body: 0.2,
    seed: 31,
  });
  addDropletScatter(data, sr, 0.05, 0.28, 5, 0.22, 32);
}

function renderSplashBig(data: Float32Array, sr: number): void {
  addNoiseBurst(data, sr, {
    start: 0.0,
    duration: 0.62,
    gain: 1.0,
    fromHz: 2500,
    toHz: 240,
    q: 1.25,
    sweepShape: 0.3,
    attack: 0.002,
    curve: 4.8,
    body: 0.35,
    seed: 41,
  });
  // Mass of water: the low thump you feel more than hear.
  pitchedBlip(data, sr, {
    start: 0.005,
    duration: 0.3,
    gain: 0.55,
    freq: 140,
    endFreq: 52,
    freqShape: 0.4,
    attack: 0.004,
    curve: 5,
    seed: 42,
  });
  addDropletScatter(data, sr, 0.12, 0.72, 14, 0.26, 43);
}

/** A bright wet scoop: a sheet of water rising, plus a small pitched ping. */
function renderCaptureCore(data: Float32Array, sr: number, gain: number): void {
  // Initial break, downward.
  addNoiseBurst(data, sr, {
    start: 0.0,
    duration: 0.24,
    gain: 0.65 * gain,
    fromHz: 2800,
    toHz: 800,
    q: 1.2,
    sweepShape: 0.35,
    attack: 0.0015,
    curve: 6,
    seed: 51,
  });
  // The sheet of water lifting with the poi, rising and opening up.
  addNoiseBurst(data, sr, {
    start: 0.01,
    duration: 0.46,
    gain: 0.8 * gain,
    fromHz: 700,
    toHz: 4400,
    q: 0.95,
    sweepShape: 0.85,
    attack: 0.03,
    curve: 3.4,
    seed: 52,
  });
  // Small bell ping so a capture is unmistakable without being an arcade jingle.
  pitchedBlip(data, sr, {
    start: 0.055,
    duration: 0.4,
    gain: 0.4 * gain,
    freq: 1174.66, // D6
    fmRatio: 2.0,
    fmIndex: 1.3,
    fmDecay: 12,
    attack: 0.002,
    curve: 5,
    seed: 53,
  });
  addDropletScatter(data, sr, 0.1, 0.62, 12, 0.24 * gain, 54);
}

function renderCapture(data: Float32Array, sr: number): void {
  renderCaptureCore(data, sr, 1);
}

/** Capture plus a shimmering high arpeggio — 金色金魚 and 出目金 (spec §108). */
function renderCaptureRare(data: Float32Array, sr: number): void {
  renderCaptureCore(data, sr, 0.9);

  // D minor pentatonic climbing into the top octave; bell-like FM, soft and glassy.
  const notes = [1174.66, 1396.91, 1567.98, 1760.0, 2093.0, 2349.32];
  for (let i = 0; i < notes.length; i++) {
    pitchedBlip(data, sr, {
      start: 0.14 + i * 0.078,
      duration: 0.75 - i * 0.05,
      gain: 0.26 - i * 0.018,
      freq: notes[i],
      fmRatio: 3.5,
      fmIndex: 0.85,
      fmDecay: 9,
      attack: 0.004,
      curve: 4.2,
      seed: 60 + i * 17,
    });
  }
  // A high air shimmer under the arpeggio so the gold "sparkles" rather than "beeps".
  addNoiseBurst(data, sr, {
    start: 0.12,
    duration: 1.2,
    gain: 0.14,
    fromHz: 6200,
    toHz: 9000,
    q: 0.8,
    sweepShape: 1.2,
    attack: 0.18,
    curve: 2.6,
    seed: 61,
  });
}

/** A short dry fibre rip — paper, not cloth: mid-band and gone in a blink. */
function renderPoiTear(data: Float32Array, sr: number): void {
  addNoiseBurst(data, sr, {
    start: 0.0,
    duration: 0.19,
    gain: 1.0,
    fromHz: 2600,
    toHz: 1500,
    q: 1.5,
    sweepShape: 0.6,
    attack: 0.001,
    curve: 6,
    crackle: 0.85,
    seed: 71,
  });
  addNoiseBurst(data, sr, {
    start: 0.0,
    duration: 0.08,
    gain: 0.35,
    fromHz: 5200,
    toHz: 4000,
    q: 2.0,
    attack: 0.0006,
    curve: 8,
    crackle: 0.7,
    seed: 72,
  });
}

/** The paper gives way completely: a bigger rip, then the fish falling back in (§56). */
function renderPoiBreak(data: Float32Array, sr: number): void {
  addNoiseBurst(data, sr, {
    start: 0.0,
    duration: 0.3,
    gain: 0.95,
    fromHz: 2200,
    toHz: 900,
    q: 1.4,
    sweepShape: 0.5,
    attack: 0.001,
    curve: 4.5,
    crackle: 0.9,
    body: 0.12,
    seed: 81,
  });
  addNoiseBurst(data, sr, {
    start: 0.02,
    duration: 0.14,
    gain: 0.4,
    fromHz: 5600,
    toHz: 3200,
    q: 2.2,
    attack: 0.0006,
    curve: 7,
    crackle: 0.8,
    seed: 82,
  });
  // The catch falls back into the tank.
  addNoiseBurst(data, sr, {
    start: 0.22,
    duration: 0.6,
    gain: 0.9,
    fromHz: 2300,
    toHz: 220,
    q: 1.25,
    sweepShape: 0.3,
    attack: 0.002,
    curve: 4.6,
    body: 0.34,
    seed: 83,
  });
  pitchedBlip(data, sr, {
    start: 0.225,
    duration: 0.32,
    gain: 0.5,
    freq: 150,
    endFreq: 50,
    freqShape: 0.4,
    attack: 0.004,
    curve: 5,
    seed: 84,
  });
  addDropletScatter(data, sr, 0.32, 0.94, 13, 0.24, 85);
}

/** A light wooden clack: the new poi handed over the counter (§57). */
function renderPoiRespawn(data: Float32Array, sr: number): void {
  addWoodHit(data, sr, 0.0, 0.85, [
    { hz: 1420, decay: 0.085, level: 1.0 },
    { hz: 2360, decay: 0.05, level: 0.55 },
    { hz: 780, decay: 0.11, level: 0.4 },
  ], 91);
}

/** 拍子木-ish, but softened: the countdown must not startle a queue of children. */
function renderCountdown(data: Float32Array, sr: number): void {
  addWoodHit(data, sr, 0.0, 0.8, [
    { hz: 1050, decay: 0.11, level: 1.0 },
    { hz: 1760, decay: 0.06, level: 0.42 },
    { hz: 620, decay: 0.13, level: 0.3 },
  ], 101);
}

/** A brighter double hit — the same wood, struck harder and twice (spec §101). */
function renderStart(data: Float32Array, sr: number): void {
  addWoodHit(data, sr, 0.0, 0.7, [
    { hz: 1240, decay: 0.1, level: 1.0 },
    { hz: 2100, decay: 0.06, level: 0.5 },
  ], 111);
  addWoodHit(data, sr, 0.135, 1.0, [
    { hz: 1560, decay: 0.16, level: 1.0 },
    { hz: 2640, decay: 0.09, level: 0.6 },
    { hz: 3900, decay: 0.05, level: 0.3 },
  ], 112);
}

/** A low gong. Inharmonic partials, a slow shimmer bloom, and a long tail (spec §102). */
function renderTimeUp(data: Float32Array, sr: number): void {
  const base = 92;
  // Ratios are deliberately inharmonic — that is the whole character of struck bronze.
  const partials = [
    { r: 1.0, decay: 2.3, gain: 0.55, delay: 0.0 },
    { r: 1.52, decay: 1.9, gain: 0.3, delay: 0.0 },
    { r: 2.0, decay: 1.6, gain: 0.24, delay: 0.01 },
    { r: 2.71, decay: 1.2, gain: 0.16, delay: 0.06 },
    { r: 3.46, decay: 0.95, gain: 0.12, delay: 0.1 },
    { r: 4.31, decay: 0.7, gain: 0.09, delay: 0.14 },
    { r: 5.77, decay: 0.5, gain: 0.06, delay: 0.18 },
  ];
  for (let i = 0; i < partials.length; i++) {
    const p = partials[i];
    // Two slightly detuned voices per partial give the slow beating a real gong has.
    for (let d = 0; d < 2; d++) {
      pitchedBlip(data, sr, {
        start: p.delay,
        duration: Math.min(p.decay, 2.4 - p.delay),
        gain: p.gain * 0.5,
        freq: base * p.r * (d === 0 ? 1 : 1.0035),
        attack: 0.006 + p.delay * 0.4,
        curve: 4.2,
        seed: 121 + i * 31 + d,
      });
    }
  }
  // The mallet strike itself.
  addNoiseBurst(data, sr, {
    start: 0.0,
    duration: 0.07,
    gain: 0.28,
    fromHz: 2400,
    toHz: 900,
    q: 1.0,
    attack: 0.0008,
    curve: 7,
    body: 0.5,
    seed: 122,
  });
}

/** A small disappointed plip: falling pitch, tiny, over quickly (§95 DROP). */
function renderDrop(data: Float32Array, sr: number): void {
  pitchedBlip(data, sr, {
    start: 0.0,
    duration: 0.2,
    gain: 0.75,
    freq: 720,
    endFreq: 210,
    freqShape: 0.45,
    attack: 0.002,
    curve: 6,
    seed: 131,
  });
  addNoiseBurst(data, sr, {
    start: 0.0,
    duration: 0.12,
    gain: 0.3,
    fromHz: 1800,
    toHz: 520,
    q: 1.2,
    sweepShape: 0.4,
    attack: 0.0015,
    curve: 7,
    seed: 132,
  });
  addDropletScatter(data, sr, 0.09, 0.28, 3, 0.14, 133);
}

/** A friendly two-note chime for PLAYER n JOINED (§26). Warm, never a notification bleep. */
function renderJoin(data: Float32Array, sr: number): void {
  pitchedBlip(data, sr, {
    start: 0.0,
    duration: 0.5,
    gain: 0.4,
    freq: 880.0, // A5
    fmRatio: 2.0,
    fmIndex: 0.9,
    fmDecay: 8,
    attack: 0.006,
    curve: 4,
    seed: 141,
  });
  pitchedBlip(data, sr, {
    start: 0.13,
    duration: 0.62,
    gain: 0.38,
    freq: 1318.51, // E6 — an open fifth, which reads as "welcome" rather than "alert"
    fmRatio: 2.0,
    fmIndex: 0.8,
    fmDecay: 7,
    attack: 0.008,
    curve: 3.6,
    seed: 142,
  });
  // A breath of air under the chime keeps it human.
  addNoiseBurst(data, sr, {
    start: 0.0,
    duration: 0.4,
    gain: 0.06,
    fromHz: 2400,
    toHz: 3600,
    q: 0.9,
    attack: 0.05,
    curve: 3,
    seed: 143,
  });
}

/**
 * A short festive flourish: a flute-ish FM line running up D minor pentatonic with a
 * couple of soft taiko underneath. Deliberately NOT an arcade fanfare (spec §111) —
 * it has to sound like it belongs to the same festival as the ambience.
 */
function renderResultFanfare(data: Float32Array, sr: number): void {
  const line = [
    { at: 0.0, hz: 587.33, len: 0.2, g: 0.3 }, // D5
    { at: 0.14, hz: 698.46, len: 0.2, g: 0.3 }, // F5
    { at: 0.29, hz: 783.99, len: 0.24, g: 0.32 }, // G5
    { at: 0.46, hz: 880.0, len: 0.28, g: 0.34 }, // A5
    { at: 0.63, hz: 1046.5, len: 0.22, g: 0.32 }, // C6
    { at: 0.77, hz: 880.0, len: 0.18, g: 0.28 }, // A5
    { at: 0.9, hz: 1174.66, len: 1.05, g: 0.4 }, // D6, held
  ];
  for (let i = 0; i < line.length; i++) {
    const n = line[i];
    pitchedBlip(data, sr, {
      start: n.at,
      duration: Math.min(n.len, 2.1 - n.at),
      gain: n.g,
      // A small scoop into each note: the way a 篠笛 is actually blown.
      freq: n.hz * 0.972,
      endFreq: n.hz,
      freqShape: 0.16,
      fmRatio: 2.0,
      fmIndex: 0.32,
      fmDecay: 14,
      attack: 0.022,
      curve: i === line.length - 1 ? 1.6 : 2.4,
      vibratoHz: 5.4,
      vibratoCents: i === line.length - 1 ? 26 : 12,
      breath: 0.3,
      seed: 151 + i * 43,
    });
    // A quiet octave doubling thickens the line without making it brassy.
    pitchedBlip(data, sr, {
      start: n.at + 0.004,
      duration: Math.min(n.len * 0.8, 2.1 - n.at),
      gain: n.g * 0.16,
      freq: n.hz * 2,
      attack: 0.03,
      curve: 3.2,
      breath: 0.2,
      seed: 251 + i * 43,
    });
  }

  // Two soft taiko: one on the downbeat, one under the held note.
  for (const at of [0.0, 0.9]) {
    pitchedBlip(data, sr, {
      start: at,
      duration: 0.42,
      gain: 0.34,
      freq: 108,
      endFreq: 62,
      freqShape: 0.35,
      attack: 0.004,
      curve: 5,
      seed: 171 + Math.floor(at * 100),
    });
    addNoiseBurst(data, sr, {
      start: at,
      duration: 0.1,
      gain: 0.14,
      fromHz: 1500,
      toHz: 500,
      q: 1.1,
      attack: 0.001,
      curve: 7,
      body: 0.45,
      seed: 181 + Math.floor(at * 100),
    });
  }
}

/** The phone's own bowl: a close-mic drop landing in a small glass of water (§92). */
function renderBowlDrop(data: Float32Array, sr: number): void {
  // The impact tick.
  addNoiseBurst(data, sr, {
    start: 0.0,
    duration: 0.05,
    gain: 0.5,
    fromHz: 3400,
    toHz: 1200,
    q: 1.1,
    sweepShape: 0.4,
    attack: 0.0008,
    curve: 8,
    seed: 191,
  });
  // The cavity: a real water drop RISES in pitch as the bubble pinches off.
  pitchedBlip(data, sr, {
    start: 0.004,
    duration: 0.13,
    gain: 0.9,
    freq: 300,
    endFreq: 980,
    freqShape: 0.42,
    attack: 0.0015,
    curve: 6.5,
    seed: 192,
  });
  // A little bowl resonance, because the phone is holding a small glass volume.
  pitchedBlip(data, sr, {
    start: 0.01,
    duration: 0.22,
    gain: 0.16,
    freq: 470,
    fmRatio: 2.4,
    fmIndex: 0.4,
    fmDecay: 14,
    attack: 0.004,
    curve: 5,
    seed: 193,
  });
  addDropletScatter(data, sr, 0.06, 0.26, 3, 0.1, 194);
}

const RENDERERS: Record<SfxName, (data: Float32Array, sampleRate: number) => void> = {
  poiEnter: renderPoiEnter,
  poiExit: renderPoiExit,
  splashSmall: renderSplashSmall,
  splashBig: renderSplashBig,
  capture: renderCapture,
  captureRare: renderCaptureRare,
  poiTear: renderPoiTear,
  poiBreak: renderPoiBreak,
  poiRespawn: renderPoiRespawn,
  countdown: renderCountdown,
  start: renderStart,
  timeUp: renderTimeUp,
  drop: renderDrop,
  join: renderJoin,
  resultFanfare: renderResultFanfare,
  bowlDrop: renderBowlDrop,
};

/**
 * Synthesises one effect into a fresh mono AudioBuffer.
 *
 * This is CPU work (a few ms each); callers should go through 'getSfx', which renders
 * once per context and caches. Playback panning is done at play time with a
 * StereoPannerNode, so everything here is mono.
 */
export function renderSfx(ctx: BaseAudioContext, name: SfxName): AudioBuffer {
  const seconds = SFX_SECONDS[name] ?? 0.5;
  const sr = ctx.sampleRate;
  const length = Math.max(1, Math.floor(seconds * sr));
  const buffer = ctx.createBuffer(1, length, sr);
  const data = buffer.getChannelData(0);

  const render = RENDERERS[name];
  if (render) render(data, sr);

  softClip(data);
  normalize(data, SFX_PEAK[name] ?? 0.7);
  applyEdgeFades(data, sr);
  return buffer;
}

/**
 * Per-context render cache. A WeakMap keyed by the context means a disposed
 * AudioContext takes its buffers with it.
 */
const CACHE = new WeakMap<BaseAudioContext, Map<SfxName, AudioBuffer>>();

/** Renders on first use, then returns the cached buffer. Never throws. */
export function getSfx(ctx: BaseAudioContext, name: SfxName): AudioBuffer | null {
  let perContext = CACHE.get(ctx);
  if (!perContext) {
    perContext = new Map<SfxName, AudioBuffer>();
    CACHE.set(ctx, perContext);
  }
  const cached = perContext.get(name);
  if (cached) return cached;
  try {
    const rendered = renderSfx(ctx, name);
    perContext.set(name, rendered);
    return rendered;
  } catch {
    return null;
  }
}

/** Drops the cached buffers for a context (used when the engine is disposed). */
export function clearSfxCache(ctx: BaseAudioContext): void {
  CACHE.delete(ctx);
}

/**
 * Renders every effect up front. Costs ~40 ms of main thread once; worth doing during
 * WAITING so the first splash of a round is never late.
 */
export function warmSfxCache(ctx: BaseAudioContext): void {
  for (const name of SFX_NAMES) getSfx(ctx, name);
}

/**
 * A synthetic reverb impulse: exponentially decaying noise, slightly darker over time.
 * Used by the ambience so the 祭囃子 reads as "somewhere else in the festival" (§111).
 */
export function renderImpulseResponse(
  ctx: BaseAudioContext,
  seconds: number,
  decay: number,
  seed = 0x1b873593,
): AudioBuffer {
  const sr = ctx.sampleRate;
  const length = Math.max(1, Math.floor(seconds * sr));
  const buffer = ctx.createBuffer(2, length, sr);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    const rng = createRng(seed + ch * 7919);
    const lp = new OnePole(sr);
    for (let i = 0; i < length; i++) {
      const u = i / length;
      const env = Math.pow(1 - u, decay);
      // The tail gets progressively darker, as air absorption actually does.
      const cutoff = 9000 * (1 - u) + 700;
      data[i] = lp.step(rng.next() * 2 - 1, cutoff) * env;
    }
    // Suppress the first few ms so the reverb never smears the transient.
    const pre = Math.floor(sr * 0.012);
    for (let i = 0; i < pre && i < length; i++) data[i] *= i / pre;
  }
  return buffer;
}
