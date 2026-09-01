/**
 * The single audio output of 巨大デジタル金魚すくい (spec §110, §111).
 *
 * Everything is synthesised — there are no audio asset files. 'sfx.ts' renders each
 * effect once into an AudioBuffer, this engine owns the graph and plays them back as
 * cheap one-shot BufferSourceNodes; 'ambience.ts' owns the continuous festival bed.
 *
 *   sources ─┬─> sfxBus ──┐
 *            └─> Ambience ┴─> master (gain) ─> compressor ─> destination
 *
 * The compressor matters at a real venue: four players splashing at once through a
 * single PA would otherwise clip. It is a glue compressor, not a limiter wall.
 *
 * Hard requirement: this module is imported by pages that server-render, and it runs on
 * phones where Web Audio may be unavailable or permanently suspended. It therefore
 * touches no browser global at module scope and NEVER throws — every public method is
 * safe to call at any time, and silently does nothing when there is no audio.
 */

import { Ambience } from './ambience';
import { clearSfxCache, getSfx, warmSfxCache, type SfxName } from './sfx';

export type { SfxName };

export interface PlayOptions {
  /** Linear gain multiplier, 1 = the effect's rendered level. */
  volume?: number;
  /** −1 (left) .. 1 (right). Derive it from the world X of the event. */
  pan?: number;
  /** Playback rate; doubles as a pitch shift. Small random variation kills machine-gunning. */
  rate?: number;
}

/** Two triggers of the same effect closer than this collapse into one (seconds). */
const RETRIGGER_GUARD = 0.022;

/** Hard ceiling on simultaneous one-shots, so a pile-up can never stall the audio thread. */
const MAX_VOICES = 28;

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

/** Resolves the constructor without ever touching 'window' at module scope. */
function resolveAudioContext(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export class AudioEngine {
  private static _instance: AudioEngine | null = null;

  static get instance(): AudioEngine {
    if (!AudioEngine._instance) AudioEngine._instance = new AudioEngine();
    return AudioEngine._instance;
  }

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private sfxBus: GainNode | null = null;
  private ambience: Ambience | null = null;

  private enabled = true;
  private masterVolume = 0.85;
  private wantsAmbience = false;
  private unavailable = false;
  private warmed = false;
  private voices = 0;

  private readonly lastPlayed = new Map<SfxName, number>();

  private constructor() {
    // Nothing here may touch the DOM: the singleton can be constructed during SSR.
  }

  // -------------------------------------------------------------------------
  // Context lifecycle
  // -------------------------------------------------------------------------

  /**
   * Creates the context and graph on first use. Returns null when Web Audio is not
   * available (SSR, an old browser, or a context we already failed to create).
   */
  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (this.unavailable) return null;

    const Ctor = resolveAudioContext();
    if (!Ctor) {
      this.unavailable = true;
      return null;
    }

    try {
      // 'interactive' asks for the smallest buffer the device will give us: a splash
      // that lags the picture is worse than no splash at all.
      const ctx = new Ctor({ latencyHint: 'interactive' });

      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -14;
      compressor.knee.value = 22;
      compressor.ratio.value = 3.5;
      compressor.attack.value = 0.004;
      compressor.release.value = 0.22;
      compressor.connect(ctx.destination);

      const master = ctx.createGain();
      master.gain.value = this.enabled ? this.masterVolume : 0;
      master.connect(compressor);

      const sfxBus = ctx.createGain();
      sfxBus.gain.value = 1;
      sfxBus.connect(master);

      this.ctx = ctx;
      this.compressor = compressor;
      this.master = master;
      this.sfxBus = sfxBus;
      this.ambience = new Ambience(ctx, master);
      return ctx;
    } catch {
      this.unavailable = true;
      return null;
    }
  }

  /**
   * Must be called from inside a user gesture — every mobile browser starts the context
   * suspended. Safe to call repeatedly.
   */
  async resume(): Promise<void> {
    const ctx = this.ensureContext();
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended') await ctx.resume();
    } catch {
      /* the browser refused; the engine stays silent rather than failing */
    }
    // Render the whole effect set off the gesture's critical path, so the first splash
    // of the round is never late waiting on synthesis.
    this.warm();
    if (this.wantsAmbience) this.ambience?.start();
  }

  /** True once there is a running context; the screen can show a "音声ON" hint until then. */
  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /** True when this device simply has no Web Audio at all. */
  get available(): boolean {
    return !this.unavailable;
  }

  private warm(): void {
    if (this.warmed) return;
    const ctx = this.ctx;
    if (!ctx) return;
    this.warmed = true;
    // ~16 buffers of offline DSP. Deferred a frame so it never blocks the tap handler.
    const run = () => {
      try {
        warmSfxCache(ctx);
      } catch {
        /* a failed pre-render just means the buffers are built on demand instead */
      }
    };
    if (typeof window === 'undefined') run();
    else window.setTimeout(run, 0);
  }

  // -------------------------------------------------------------------------
  // Mixing
  // -------------------------------------------------------------------------

  setEnabled(v: boolean): void {
    this.enabled = v;
    this.applyMasterGain();
    if (!v) this.ambience?.stop();
    else if (this.wantsAmbience && this.ready) this.ambience?.start();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** 0..1 (values above 1 are allowed for a quiet venue, clamped at 2). */
  setMasterVolume(v: number): void {
    this.masterVolume = Number.isFinite(v) ? Math.min(2, Math.max(0, v)) : 0;
    this.applyMasterGain();
  }

  get masterVolumeValue(): number {
    return this.masterVolume;
  }

  private applyMasterGain(): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const target = this.enabled ? this.masterVolume : 0;
    try {
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.linearRampToValueAtTime(target, now + 0.08); // a step here would click
    } catch {
      master.gain.value = target;
    }
  }

  // -------------------------------------------------------------------------
  // Playback
  // -------------------------------------------------------------------------

  /**
   * Fires one effect. Never throws, never awaits, and is a no-op when audio is disabled
   * or the context has not been unlocked yet — callers can sprinkle this freely through
   * game event handlers without guarding.
   */
  play(name: SfxName, opts?: PlayOptions): void {
    if (!this.enabled) return;
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state !== 'running') {
      // Autoplay policy: try to unlock in the background but drop this one.
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
      return;
    }
    const bus = this.sfxBus;
    if (!bus) return;
    if (this.voices >= MAX_VOICES) return;

    const now = ctx.currentTime;
    const last = this.lastPlayed.get(name);
    if (last !== undefined && now - last < RETRIGGER_GUARD) return;

    const buffer = getSfx(ctx, name);
    if (!buffer) return;

    try {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const rate = clampFinite(opts?.rate, 1, 0.25, 4);
      source.playbackRate.value = rate;

      const gain = ctx.createGain();
      gain.gain.value = clampFinite(opts?.volume, 1, 0, 4);

      let head: AudioNode = gain;
      let panner: StereoPannerNode | null = null;
      const pan = clampFinite(opts?.pan, 0, -1, 1);
      if (pan !== 0 && typeof ctx.createStereoPanner === 'function') {
        panner = ctx.createStereoPanner();
        panner.pan.value = pan;
        gain.connect(panner);
        head = panner;
      }

      source.connect(gain);
      head.connect(bus);

      this.voices++;
      source.onended = () => {
        this.voices--;
        try {
          source.disconnect();
          gain.disconnect();
          panner?.disconnect();
        } catch {
          /* already detached */
        }
      };
      source.start();
      this.lastPlayed.set(name, now);
    } catch {
      /* a single dropped effect is always preferable to a thrown error mid-round */
    }
  }

  // -------------------------------------------------------------------------
  // Ambience (§110, §111)
  // -------------------------------------------------------------------------

  /** 夏祭りの環境音 + 遠くの祭囃子. Idempotent; starts for real once the context runs. */
  startAmbience(): void {
    this.wantsAmbience = true;
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ready) return;
    this.ambience?.start();
  }

  stopAmbience(): void {
    this.wantsAmbience = false;
    this.ambience?.stop();
  }

  /**
   * 0..1 — how busy the tank is. Raise it during PLAYING, drop it for RESULT so the
   * announcements sit clear of the bed.
   */
  setAmbienceIntensity(v: number): void {
    this.ambience?.setIntensity(v);
  }

  // -------------------------------------------------------------------------

  dispose(): void {
    this.ambience?.dispose();
    this.ambience = null;
    this.lastPlayed.clear();
    this.voices = 0;
    this.warmed = false;
    this.wantsAmbience = false;

    const ctx = this.ctx;
    try {
      this.sfxBus?.disconnect();
      this.master?.disconnect();
      this.compressor?.disconnect();
    } catch {
      /* already detached */
    }
    this.sfxBus = null;
    this.master = null;
    this.compressor = null;
    this.ctx = null;

    if (ctx) {
      clearSfxCache(ctx);
      try {
        void ctx.close().catch(() => undefined);
      } catch {
        /* already closed */
      }
    }
    // A later resume() rebuilds the whole graph from scratch.
    this.unavailable = false;
  }
}

function clampFinite(v: number | undefined, fallback: number, lo: number, hi: number): number {
  if (v === undefined || !Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

/** Convenience accessor so call sites read as 'audio.play('capture')'. */
export const audio = {
  get engine(): AudioEngine {
    return AudioEngine.instance;
  },
  play(name: SfxName, opts?: PlayOptions): void {
    AudioEngine.instance.play(name, opts);
  },
  resume(): Promise<void> {
    return AudioEngine.instance.resume();
  },
};
