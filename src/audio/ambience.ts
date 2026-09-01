/**
 * 夏祭りの環境音 — the continuous bed the whole installation sits inside (spec §110, §111).
 *
 * Spec §111 is explicit that an arcade BGM must not be the main voice. So there is no BGM:
 * this ambience IS the main voice. Three layers, all synthesised:
 *
 *   1. water   — filtered pink noise, two slow LFOs shaping it into gentle water movement.
 *   2. crowd   — heavily low-passed noise with a slow amplitude drift; a distant queue.
 *   3. 祭囃子   — a SPARSE D minor pentatonic flute motif with an occasional soft taiko,
 *                humanised in time and pitch, pushed through a long delay and a synthetic
 *                reverb so it reads as coming from another stall, not from this one.
 *
 * The motif deliberately leaves long gaps (9–22 s). Silence is what makes it feel like a
 * real festival rather than a loop.
 */

import { clamp, createRng } from '@/game/core/math';
import { fillPinkNoise, renderImpulseResponse } from './sfx';

/** Scale the flute plays. D minor pentatonic, two octaves. */
const SCALE = [293.66, 349.23, 392.0, 440.0, 523.25, 587.33, 698.46, 783.99, 880.0, 1046.5];

/** Contours as indices into SCALE, transposed at phrase time. Short, singable, incomplete. */
const MOTIFS: readonly (readonly number[])[] = [
  [0, 2, 3, 4],
  [4, 3, 2, 0],
  [0, 1, 2, 1, 0],
  [2, 3, 4, 3, 2],
  [3, 4, 5, 4],
  [0, 2, 1, 0],
  [2, 4, 3, 2, 0],
  [5, 4, 2, 3],
];

interface ScheduledNote {
  /** Seconds from the phrase start. */
  at: number;
  freq: number;
  duration: number;
  gain: number;
  taiko: boolean;
}

export class Ambience {
  private readonly ctx: AudioContext;
  private readonly dest: AudioNode;
  private readonly rng = createRng(0x5f3a71c9);

  private running = false;
  private disposed = false;
  private intensity = 1;

  /** Persistent graph, built on first start(). */
  private out: GainNode | null = null;
  private waterGain: GainNode | null = null;
  private waterFilter: BiquadFilterNode | null = null;
  private crowdGain: GainNode | null = null;
  /** Entry node of the crowd chain — the murmur source connects here. */
  private crowdEntry: BiquadFilterNode | null = null;
  private matsuriBus: GainNode | null = null;
  private matsuriPan: StereoPannerNode | null = null;

  /** Nodes created per start() and torn down on stop(). */
  private sources: AudioScheduledSourceNode[] = [];

  /** Shared looping noise buffers — rendered once, reused by every voice. */
  private pinkBuffer: AudioBuffer | null = null;
  private whiteBuffer: AudioBuffer | null = null;

  private schedulerId: number | null = null;
  private teardownId: number | null = null;

  /** Phrase state for the 祭囃子 scheduler. */
  private phrase: ScheduledNote[] = [];
  private phraseIndex = 0;
  private phraseStart = 0;

  constructor(ctx: AudioContext, dest: AudioNode) {
    this.ctx = ctx;
    this.dest = dest;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    if (this.disposed || this.running) return;
    if (this.ctx.state === 'closed') return;
    try {
      // A stop() still fading out leaves its sources alive; reuse them rather than
      // stacking a second copy of every layer on top.
      const restartingDuringFadeOut = this.teardownId !== null;
      this.cancelTeardown();
      this.buildGraph();
      if (!restartingDuringFadeOut) this.startLayers();
      this.running = true;

      const out = this.out;
      if (out) {
        // Long fade-in: the ambience should seem to have always been there.
        const now = this.ctx.currentTime;
        out.gain.cancelScheduledValues(now);
        out.gain.setValueAtTime(Math.max(0.0001, out.gain.value), now);
        out.gain.linearRampToValueAtTime(this.targetGain(), now + 2.6);
      }

      // First phrase only after a while — the room should settle before the flute enters.
      this.phrase = [];
      this.phraseIndex = 0;
      this.phraseStart = this.ctx.currentTime + this.rng.range(5, 11);
      this.schedulerId = this.setIntervalSafe(() => this.pumpScheduler(), 220);
    } catch {
      this.running = false;
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    try {
      this.clearScheduler();
      const out = this.out;
      const now = this.ctx.currentTime;
      if (out) {
        out.gain.cancelScheduledValues(now);
        out.gain.setValueAtTime(Math.max(0.0001, out.gain.value), now);
        out.gain.linearRampToValueAtTime(0.0001, now + 1.4);
      }
      // Let the fade finish before killing the sources, otherwise it clicks.
      this.teardownId = this.setTimeoutSafe(() => {
        this.teardownId = null;
        this.stopSources();
      }, 1700);
    } catch {
      this.stopSources();
    }
  }

  /** 0..1. Scales the bed and slightly opens the water filter as it rises. */
  setIntensity(v: number): void {
    this.intensity = clamp(v, 0, 1);
    if (this.disposed) return;
    try {
      const now = this.ctx.currentTime;
      if (this.out && this.running) {
        this.out.gain.cancelScheduledValues(now);
        this.out.gain.setValueAtTime(Math.max(0.0001, this.out.gain.value), now);
        this.out.gain.linearRampToValueAtTime(this.targetGain(), now + 0.8);
      }
      if (this.waterFilter) {
        // More activity in the tank => a brighter, busier water bed.
        this.waterFilter.frequency.cancelScheduledValues(now);
        this.waterFilter.frequency.linearRampToValueAtTime(700 + this.intensity * 900, now + 1.2);
      }
    } catch {
      /* an AudioParam on a closed context — nothing to do */
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    this.clearScheduler();
    this.cancelTeardown();
    this.stopSources();
    try {
      this.out?.disconnect();
      this.waterGain?.disconnect();
      this.waterFilter?.disconnect();
      this.crowdGain?.disconnect();
      this.crowdEntry?.disconnect();
      this.matsuriBus?.disconnect();
      this.matsuriPan?.disconnect();
    } catch {
      /* already detached */
    }
    this.out = null;
    this.waterGain = null;
    this.waterFilter = null;
    this.crowdGain = null;
    this.crowdEntry = null;
    this.matsuriBus = null;
    this.matsuriPan = null;
    this.pinkBuffer = null;
    this.whiteBuffer = null;
  }

  get active(): boolean {
    return this.running;
  }

  // -------------------------------------------------------------------------
  // Graph construction
  // -------------------------------------------------------------------------

  private targetGain(): number {
    // The bed must never compete with the sound effects; it lives under everything.
    return 0.0001 + 0.34 * this.intensity;
  }

  private buildGraph(): void {
    if (this.out) return;
    const ctx = this.ctx;

    const out = ctx.createGain();
    out.gain.value = 0.0001;
    out.connect(this.dest);
    this.out = out;

    // --- water bed -------------------------------------------------------
    const waterFilter = ctx.createBiquadFilter();
    waterFilter.type = 'lowpass';
    waterFilter.frequency.value = 700 + this.intensity * 900;
    waterFilter.Q.value = 0.6;

    const waterHigh = ctx.createBiquadFilter();
    waterHigh.type = 'highpass';
    waterHigh.frequency.value = 110;
    waterHigh.Q.value = 0.5;

    const waterGain = ctx.createGain();
    waterGain.gain.value = 0.42;

    waterFilter.connect(waterHigh);
    waterHigh.connect(waterGain);
    waterGain.connect(out);
    this.waterFilter = waterFilter;
    this.waterGain = waterGain;

    // --- crowd murmur ----------------------------------------------------
    const crowdLow = ctx.createBiquadFilter();
    crowdLow.type = 'lowpass';
    crowdLow.frequency.value = 360;
    crowdLow.Q.value = 0.5;

    const crowdHigh = ctx.createBiquadFilter();
    crowdHigh.type = 'highpass';
    crowdHigh.frequency.value = 95;

    const crowdGain = ctx.createGain();
    crowdGain.gain.value = 0.1;

    crowdLow.connect(crowdHigh);
    crowdHigh.connect(crowdGain);
    crowdGain.connect(out);
    this.crowdGain = crowdGain;
    this.crowdEntry = crowdLow;

    // --- 祭囃子 bus: distance filtering, long delay, synthetic reverb -----
    const matsuriBus = ctx.createGain();
    matsuriBus.gain.value = 1;

    // Air absorption over distance: a real stall two rows away has no top end.
    const distance = ctx.createBiquadFilter();
    distance.type = 'lowpass';
    distance.frequency.value = 1900;
    distance.Q.value = 0.5;

    const distanceHigh = ctx.createBiquadFilter();
    distanceHigh.type = 'highpass';
    distanceHigh.frequency.value = 220;

    const pan = ctx.createStereoPanner();
    pan.pan.value = -0.25;

    matsuriBus.connect(distance);
    distance.connect(distanceHigh);
    distanceHigh.connect(pan);

    const delay = ctx.createDelay(1.2);
    delay.delayTime.value = 0.37;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.34;
    const feedbackDamp = ctx.createBiquadFilter();
    feedbackDamp.type = 'lowpass';
    feedbackDamp.frequency.value = 1500;

    delay.connect(feedbackDamp);
    feedbackDamp.connect(feedback);
    feedback.connect(delay);

    const convolver = ctx.createConvolver();
    convolver.normalize = true;
    convolver.buffer = renderImpulseResponse(ctx, 2.8, 2.4);

    const dry = ctx.createGain();
    dry.gain.value = 0.3;
    const wet = ctx.createGain();
    wet.gain.value = 0.85;
    const echo = ctx.createGain();
    echo.gain.value = 0.5;

    pan.connect(dry);
    dry.connect(out);
    pan.connect(convolver);
    pan.connect(delay);
    delay.connect(echo);
    echo.connect(convolver);
    convolver.connect(wet);
    wet.connect(out);

    this.matsuriBus = matsuriBus;
    this.matsuriPan = pan;
  }

  private ensureBuffers(): void {
    const ctx = this.ctx;
    if (!this.pinkBuffer) {
      // 9.1 s: a prime-ish length so the loop point never lines up with the LFOs.
      const len = Math.floor(ctx.sampleRate * 9.1);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      fillPinkNoise(data, 0x4f6cdd1d);
      // Cross-fade the seam so a 9 s loop has no audible click.
      const fade = Math.floor(ctx.sampleRate * 0.25);
      for (let i = 0; i < fade; i++) {
        const k = i / fade;
        data[i] = data[i] * k + data[len - fade + i] * (1 - k);
      }
      this.pinkBuffer = buf;
    }
    if (!this.whiteBuffer) {
      const len = Math.floor(ctx.sampleRate * 11.3);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      const rng = createRng(0x2f9d3b17);
      for (let i = 0; i < len; i++) data[i] = rng.next() * 2 - 1;
      const fade = Math.floor(ctx.sampleRate * 0.3);
      for (let i = 0; i < fade; i++) {
        const k = i / fade;
        data[i] = data[i] * k + data[len - fade + i] * (1 - k);
      }
      this.whiteBuffer = buf;
    }
  }

  private startLayers(): void {
    const ctx = this.ctx;
    this.ensureBuffers();
    const pink = this.pinkBuffer;
    const white = this.whiteBuffer;
    const waterFilter = this.waterFilter;
    const crowdEntry = this.crowdEntry;
    const out = this.out;
    if (!pink || !white || !waterFilter || !crowdEntry || !out) return;
    const now = ctx.currentTime;

    // Two detuned copies of the same pink noise: a surface layer and a deeper wash.
    for (const rate of [1.0, 0.62]) {
      const src = ctx.createBufferSource();
      src.buffer = pink;
      src.loop = true;
      src.playbackRate.value = rate;
      const g = ctx.createGain();
      g.gain.value = rate === 1 ? 1 : 0.55;
      src.connect(g);
      g.connect(waterFilter);
      src.start(now + this.rng.range(0, 0.4));
      this.sources.push(src);
    }

    // Slow LFOs on the water: one opens the filter, one breathes the level.
    this.addLfo(0.071, 240, waterFilter.frequency, now);
    if (this.waterGain) this.addLfo(0.033, 0.14, this.waterGain.gain, now);

    // A faint high shimmer — the surface catching the stall lights.
    const shimmerSrc = ctx.createBufferSource();
    shimmerSrc.buffer = pink;
    shimmerSrc.loop = true;
    shimmerSrc.playbackRate.value = 1.37;
    const shimmerBand = ctx.createBiquadFilter();
    shimmerBand.type = 'bandpass';
    shimmerBand.frequency.value = 4200;
    shimmerBand.Q.value = 0.8;
    const shimmerGain = ctx.createGain();
    shimmerGain.gain.value = 0.05;
    shimmerSrc.connect(shimmerBand);
    shimmerBand.connect(shimmerGain);
    shimmerGain.connect(out);
    this.addLfo(0.019, 0.03, shimmerGain.gain, now);
    shimmerSrc.start(now);
    this.sources.push(shimmerSrc);

    // Crowd: slowed white noise, brutally low-passed. Two drifts at unrelated rates so
    // the murmur never settles into a pattern the ear can lock onto.
    const crowdSrc = ctx.createBufferSource();
    crowdSrc.buffer = white;
    crowdSrc.loop = true;
    crowdSrc.playbackRate.value = 0.83;
    crowdSrc.connect(crowdEntry);
    crowdSrc.start(now);
    this.sources.push(crowdSrc);
    if (this.crowdGain) {
      this.addLfo(0.091, 0.045, this.crowdGain.gain, now);
      this.addLfo(0.037, 0.03, this.crowdGain.gain, now);
    }

    // The distant stall drifts very slowly across the stereo field.
    if (this.matsuriPan) this.addLfo(0.021, 0.32, this.matsuriPan.pan, now);
  }

  /** A sine LFO added onto an AudioParam. The oscillator is tracked for teardown. */
  private addLfo(hz: number, depth: number, param: AudioParam, startAt: number): void {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = hz;
    const g = ctx.createGain();
    g.gain.value = depth;
    osc.connect(g);
    g.connect(param);
    osc.start(startAt + this.rng.range(0, 3)); // random phase per layer
    this.sources.push(osc);
  }

  private stopSources(): void {
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      try {
        src.disconnect();
      } catch {
        /* already detached */
      }
    }
    this.sources.length = 0;
  }

  // -------------------------------------------------------------------------
  // 祭囃子 scheduler
  // -------------------------------------------------------------------------

  /**
   * Lookahead scheduler. Runs on a coarse timer but schedules every note against
   * 'ctx.currentTime', so timer jitter never reaches the audio.
   */
  private pumpScheduler(): void {
    if (!this.running || this.disposed) return;
    try {
      const now = this.ctx.currentTime;
      const horizon = now + 1.4;

      while (this.phraseStart + this.currentNoteOffset() <= horizon) {
        if (this.phraseIndex >= this.phrase.length) {
          this.buildPhrase(now);
          if (this.phraseStart > horizon) break;
          continue;
        }
        const note = this.phrase[this.phraseIndex];
        const at = Math.max(now + 0.01, this.phraseStart + note.at);
        if (note.taiko) this.playTaiko(at, note.gain);
        else this.playFlute(at, note.freq, note.duration, note.gain);
        this.phraseIndex++;
      }
    } catch {
      /* a scheduling failure must never take the installation down */
    }
  }

  private currentNoteOffset(): number {
    if (this.phraseIndex >= this.phrase.length) return 0;
    return this.phrase[this.phraseIndex].at;
  }

  /** Generates the next phrase and the long silence that follows it. */
  private buildPhrase(now: number): void {
    const rng = this.rng;
    if (this.phrase.length === 0) {
      // First phrase after start(): phraseStart already holds the intended entry time.
      this.phraseStart = Math.max(now + 0.5, this.phraseStart);
    } else {
      const last = this.phrase[this.phrase.length - 1];
      const previousEnd = this.phraseStart + last.at + last.duration;
      // Long gaps are the point: this must sound like another stall, not a soundtrack.
      this.phraseStart = Math.max(now + 0.5, previousEnd + rng.range(9, 22));
    }

    const motif = rng.pick(MOTIFS);
    const octave = rng.next() < 0.35 ? 5 : 0; // occasionally the same line an octave up
    const beat = rng.range(0.26, 0.4);
    const notes: ScheduledNote[] = [];

    // A soft taiko marks roughly half of the phrases.
    const withTaiko = rng.next() < 0.55;
    if (withTaiko) {
      notes.push({ at: 0, freq: 0, duration: 0.5, gain: rng.range(0.18, 0.3), taiko: true });
    }

    let t = withTaiko ? beat * rng.range(0.4, 1.0) : 0;
    for (let i = 0; i < motif.length; i++) {
      const degree = clamp(motif[i] + octave, 0, SCALE.length - 1);
      // Humanisation: a few cents of pitch drift and a few tens of ms of timing drift.
      const cents = rng.range(-14, 14);
      const freq = SCALE[degree] * Math.pow(2, cents / 1200);
      const last = i === motif.length - 1;
      const dur = last ? beat * rng.range(2.4, 3.6) : beat * rng.range(0.85, 1.25);
      notes.push({
        at: t + rng.range(-0.028, 0.038),
        freq,
        duration: dur,
        gain: rng.range(0.7, 1.0) * (last ? 1.05 : 1),
        taiko: false,
      });
      t += last ? dur : beat * (rng.next() < 0.2 ? 2 : 1);
    }

    // A second taiko under the held note, sometimes.
    if (withTaiko && rng.next() < 0.5) {
      notes.push({ at: t - beat * 0.5, freq: 0, duration: 0.5, gain: rng.range(0.14, 0.24), taiko: true });
    }

    notes.sort((a, b) => a.at - b.at);
    this.phrase = notes;
    this.phraseIndex = 0;
  }

  /**
   * A 篠笛-ish voice: sine carrier with a light 2:1 FM partial, a breath noise band and
   * a vibrato that fades in. Everything is disconnected from 'onended'.
   */
  private playFlute(at: number, freq: number, duration: number, velocity: number): void {
    const ctx = this.ctx;
    const bus = this.matsuriBus;
    if (!bus) return;

    const stopAt = at + duration + 0.35;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.linearRampToValueAtTime(0.16 * velocity, at + 0.07); // breathy, slow attack
    env.gain.setValueAtTime(0.16 * velocity, at + duration * 0.72);
    env.gain.exponentialRampToValueAtTime(0.0001, at + duration + 0.3);
    env.connect(bus);

    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.setValueAtTime(freq * 0.978, at); // the scoop into the note
    carrier.frequency.exponentialRampToValueAtTime(freq, at + 0.06);
    carrier.connect(env);

    // 2:1 FM at a small index gives the hollow second partial a flute has.
    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = freq * 2;
    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(freq * 0.22, at);
    modGain.gain.exponentialRampToValueAtTime(freq * 0.05, at + 0.25);
    mod.connect(modGain);
    modGain.connect(carrier.frequency);

    const vib = ctx.createOscillator();
    vib.type = 'sine';
    vib.frequency.value = this.rng.range(4.6, 5.9);
    const vibGain = ctx.createGain();
    vibGain.gain.setValueAtTime(0.0001, at);
    vibGain.gain.linearRampToValueAtTime(freq * 0.008, at + Math.min(0.35, duration * 0.6));
    vib.connect(vibGain);
    vibGain.connect(carrier.frequency);

    const breathBuf = this.whiteBuffer;
    let breath: AudioBufferSourceNode | null = null;
    if (breathBuf) {
      breath = ctx.createBufferSource();
      breath.buffer = breathBuf;
      breath.loop = true;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = freq * 2.05;
      band.Q.value = 1.0;
      const breathGain = ctx.createGain();
      breathGain.gain.value = 0.5;
      breath.connect(band);
      band.connect(breathGain);
      breathGain.connect(env);
      breath.start(at, this.rng.range(0, 8));
      breath.stop(stopAt);
    }

    carrier.start(at);
    mod.start(at);
    vib.start(at);
    carrier.stop(stopAt);
    mod.stop(stopAt);
    vib.stop(stopAt);

    carrier.onended = () => {
      try {
        carrier.disconnect();
        mod.disconnect();
        modGain.disconnect();
        vib.disconnect();
        vibGain.disconnect();
        breath?.disconnect();
        env.disconnect();
      } catch {
        /* already detached */
      }
    };
  }

  /** A soft distant taiko: a pitched thump plus a low-passed skin transient. */
  private playTaiko(at: number, velocity: number): void {
    const ctx = this.ctx;
    const bus = this.matsuriBus;
    if (!bus) return;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.linearRampToValueAtTime(0.5 * velocity, at + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
    env.connect(bus);

    const body = ctx.createOscillator();
    body.type = 'sine';
    body.frequency.setValueAtTime(118, at);
    body.frequency.exponentialRampToValueAtTime(58, at + 0.18);
    body.connect(env);
    body.start(at);
    body.stop(at + 0.55);

    let skin: AudioBufferSourceNode | null = null;
    if (this.whiteBuffer) {
      skin = ctx.createBufferSource();
      skin.buffer = this.whiteBuffer;
      const skinFilter = ctx.createBiquadFilter();
      skinFilter.type = 'lowpass';
      skinFilter.frequency.value = 900;
      const skinGain = ctx.createGain();
      skinGain.gain.setValueAtTime(0.35 * velocity, at);
      skinGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.08);
      skin.connect(skinFilter);
      skinFilter.connect(skinGain);
      skinGain.connect(bus);
      skin.start(at, this.rng.range(0, 8), 0.12);
    }

    body.onended = () => {
      try {
        body.disconnect();
        env.disconnect();
        skin?.disconnect();
      } catch {
        /* already detached */
      }
    };
  }

  // -------------------------------------------------------------------------
  // Timer helpers (guarded so the module is inert outside a browser)
  // -------------------------------------------------------------------------

  private setIntervalSafe(fn: () => void, ms: number): number | null {
    if (typeof window === 'undefined') return null;
    return window.setInterval(fn, ms);
  }

  private setTimeoutSafe(fn: () => void, ms: number): number | null {
    if (typeof window === 'undefined') return null;
    return window.setTimeout(fn, ms);
  }

  private clearScheduler(): void {
    if (this.schedulerId !== null && typeof window !== 'undefined') {
      window.clearInterval(this.schedulerId);
    }
    this.schedulerId = null;
  }

  private cancelTeardown(): void {
    if (this.teardownId !== null && typeof window !== 'undefined') {
      window.clearTimeout(this.teardownId);
    }
    this.teardownId = null;
  }
}
