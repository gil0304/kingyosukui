'use client';

/**
 * The whole tank, as one R3F scene graph.
 *
 * Two rules shape everything in this file.
 *
 * 1. RENDER OWNERSHIP. 'WaterSurface' runs a priority-1 frame callback and drives the
 *    render itself, because it has to capture the underwater image into an FBO before
 *    the final pass. A post-processing composer wants to own exactly the same slot. So
 *    only one of them is ever allowed to present: with post FX on, the water still
 *    produces its refraction buffer but hands the final draw to the composer
 *    (renderScene={false}); with post FX off, the water presents and Effects is not
 *    mounted at all. Never both.
 *
 * 2. NO REACT STATE PER FRAME. The socket buffers are sampled inside a single frame
 *    callback that mutates long-lived objects — one array of fish snapshots and one
 *    PoiWire per seat — which the presentation components already read through refs.
 *    React re-renders only when the SET of poi changes, which happens when somebody
 *    joins or leaves. That callback lives in 'SceneDriver', mounted as the first child,
 *    so it is registered before every consumer and everything downstream reads data
 *    produced this frame rather than last frame's.
 *
 * The poi are the latency path (spec §39): they are sampled against the real clock and
 * never delayed. The fish run on their OWN clock, which is what makes the slow-motion
 * beat after a capture possible without a single player feeling their phone lag (§79).
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import { audio } from '@/audio/AudioEngine';
import { CAPTURE, PLAYER_COLORS, POI, POI_START_X, TANK } from '@/game/core/constants';
import { clamp, nowSeconds, smoothstep } from '@/game/core/math';
import { getFishData } from '@/game/fish/fishTypes';
import { FishSchool } from '@/game/fish/FishSchool';
import { Lanterns } from '@/game/environment/Lanterns';
import { FestivalLighting } from '@/game/environment/Lighting';
import { FestivalStall } from '@/game/environment/FestivalStall';
import { PoiGhost, PoiView } from '@/game/poi/PoiView';
import { Caustics } from '@/game/water/Caustics';
import { Underwater } from '@/game/water/Underwater';
import { WaterSurface, useRippleField } from '@/game/water/WaterSurface';
import type { PoiWire } from '@/network/protocol/codec';
import type { ScreenSocketApi } from '@/network/socket/useScreenSocket';
import type { SplashPayload } from '@/network/protocol/events';
import { Bubbles } from '@/rendering/particles/Bubbles';
import { Droplets, type DropletHandle } from '@/rendering/particles/Droplets';
import { DIAG } from '@/rendering/diagFlags';
import {
  SplashSystem,
  type SplashEffectKind,
  type SplashHandle,
} from '@/rendering/particles/SplashSystem';
import { Effects } from '@/rendering/postprocessing/Effects';
import type { FishSnapshot } from '@/types';

// ---------------------------------------------------------------------------
// Event mapping tables
// ---------------------------------------------------------------------------

/** Protocol splash kind -> particle flavour. */
const SPLASH_KIND: Record<SplashPayload['kind'], SplashEffectKind> = {
  ENTER: 'enter',
  EXIT: 'exit',
  CAPTURE: 'capture',
  POI_COLLIDE: 'collide',
  BREAK: 'break',
  FISH_SURFACE: 'fish',
};

/**
 * Ripple amplitude and radius per splash kind, using the reference values documented on
 * 'RippleField.addRipple'. Negative pushes the surface down (something going in),
 * positive lifts it (something coming out).
 */
const RIPPLE_SPEC: Record<SplashPayload['kind'], { amp: number; radius: number }> = {
  ENTER: { amp: -0.3, radius: 0.62 },
  EXIT: { amp: 0.35, radius: 0.58 },
  CAPTURE: { amp: 0.7, radius: 0.74 },
  POI_COLLIDE: { amp: 0.15, radius: 0.45 },
  BREAK: { amp: 0.62, radius: 0.9 },
  FISH_SURFACE: { amp: 0.1, radius: 0.22 },
};

const pan = (x: number): number => clamp(x / TANK.halfWidth, -1, 1);

// ---------------------------------------------------------------------------
// Floating score numbers
// ---------------------------------------------------------------------------

/**
 * Text sprites. The key space is bounded — five fish scores and one break penalty across
 * four player colours — so this cache never needs eviction.
 */
const popupTextures = new Map<string, THREE.Texture>();

function popupTexture(text: string, color: string): THREE.Texture | null {
  const key = `${text}|${color}`;
  const hit = popupTextures.get(key);
  if (hit) return hit;
  if (typeof document === 'undefined') return null;

  const w = 512;
  const h = 192;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.clearRect(0, 0, w, h);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 122px "DIN Alternate", "Helvetica Neue", Arial, sans-serif';
  ctx.lineJoin = 'round';

  // A heavy dark rim: the number has to survive being drawn over bright rippling water.
  ctx.strokeStyle = 'rgba(4,5,11,0.94)';
  ctx.lineWidth = 20;
  ctx.strokeText(text, w / 2, h / 2 + 6);
  ctx.fillStyle = color;
  ctx.fillText(text, w / 2, h / 2 + 6);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  popupTextures.set(key, tex);
  return tex;
}

export interface ScorePopupApi {
  spawn(x: number, y: number, z: number, text: string, color: string): void;
}

interface PopupSlot {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  life: number;
  ttl: number;
  x: number;
  y: number;
  z: number;
}

const POPUP_COUNT = 8;

/** The points a scoop was worth, rising off the poi that earned them. */
function ScorePopups({ apiRef }: { apiRef: RefObject<ScorePopupApi | null> }) {
  const slots = useMemo<PopupSlot[]>(() => {
    const made: PopupSlot[] = [];
    for (let i = 0; i < POPUP_COUNT; i++) {
      const material = new THREE.SpriteMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: false,
        opacity: 0,
        toneMapped: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      sprite.renderOrder = 40;
      sprite.frustumCulled = false;
      made.push({ sprite, material, life: 0, ttl: 1, x: 0, y: 0, z: 0 });
    }
    return made;
  }, []);

  useEffect(
    () => () => {
      for (const s of slots) {
        s.material.dispose();
        s.sprite.removeFromParent();
      }
    },
    [slots],
  );

  useEffect(() => {
    const cursor = { next: 0 };
    apiRef.current = {
      spawn(x, y, z, text, color) {
        const tex = popupTexture(text, color);
        if (!tex) return;
        // Round-robin: the oldest popup is always the one that gives way.
        const slot = slots[cursor.next % slots.length];
        cursor.next++;
        slot.material.map = tex;
        slot.material.needsUpdate = true;
        slot.life = 0;
        slot.ttl = 1.55;
        slot.x = x;
        // A little jitter so two simultaneous captures never stack into one blob.
        slot.y = y + 0.34;
        slot.z = z + (Math.random() - 0.5) * 0.16;
        slot.sprite.visible = true;
      },
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, slots]);

  useFrame((_state, delta) => {
    const dt = Math.min(delta, 0.05);
    for (const s of slots) {
      if (!s.sprite.visible) continue;
      s.life += dt;
      const t = s.life / s.ttl;
      if (t >= 1) {
        s.sprite.visible = false;
        s.material.opacity = 0;
        continue;
      }
      // Rises fast, then coasts: the eye catches it and then has time to read it.
      const rise = 1 - Math.pow(1 - t, 2.4);
      const pop = t < 0.18 ? 0.62 + 0.38 * smoothstep(0, 0.18, t) : 1;
      const fade = t < 0.62 ? 1 : 1 - smoothstep(0.62, 1, t);
      s.sprite.position.set(s.x, s.y + rise * 1.15, s.z);
      s.sprite.scale.set(1.72 * pop, 0.645 * pop, 1);
      s.material.opacity = fade;
    }
  });

  return (
    <group name="score-popups">
      {slots.map((s, i) => (
        <primitive key={i} object={s.sprite} />
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Glints
// ---------------------------------------------------------------------------

let glintTexture: THREE.Texture | null = null;
function getGlintTexture(): THREE.Texture | null {
  if (glintTexture) return glintTexture;
  if (typeof document === 'undefined') return null;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.24, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  glintTexture = tex;
  return tex;
}

export interface GlintApi {
  spawn(x: number, y: number, z: number, color: string, scale: number, seconds: number): void;
}

interface GlintSlot {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  life: number;
  ttl: number;
  scale: number;
}

const GLINT_COUNT = 6;

/**
 * A rare fish gets a glint and nothing else (spec §108). No banner, no arrow, no sound:
 * the whole pleasure is in one person spotting the gold fish before anyone else does.
 *
 * These are additive sprites rather than real lights on purpose — adding and removing
 * point lights changes the light count and forces three.js to recompile every material
 * in the scene, which is a visible hitch on a projector.
 */
function Glints({ apiRef }: { apiRef: RefObject<GlintApi | null> }) {
  const slots = useMemo<GlintSlot[]>(() => {
    const tex = getGlintTexture();
    const made: GlintSlot[] = [];
    for (let i = 0; i < GLINT_COUNT; i++) {
      const material = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
        opacity: 0,
        toneMapped: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      sprite.renderOrder = 30;
      sprite.frustumCulled = false;
      made.push({ sprite, material, life: 0, ttl: 1, scale: 1 });
    }
    return made;
  }, []);

  useEffect(
    () => () => {
      for (const s of slots) {
        s.material.dispose();
        s.sprite.removeFromParent();
      }
    },
    [slots],
  );

  useEffect(() => {
    const cursor = { next: 0 };
    apiRef.current = {
      spawn(x, y, z, color, scale, seconds) {
        const slot = slots[cursor.next % slots.length];
        cursor.next++;
        slot.material.color.set(color);
        slot.life = 0;
        slot.ttl = seconds;
        slot.scale = scale;
        slot.sprite.position.set(x, y, z);
        slot.sprite.visible = true;
      },
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, slots]);

  useFrame((_state, delta) => {
    const dt = Math.min(delta, 0.05);
    for (const s of slots) {
      if (!s.sprite.visible) continue;
      s.life += dt;
      const t = s.life / s.ttl;
      if (t >= 1) {
        s.sprite.visible = false;
        s.material.opacity = 0;
        continue;
      }
      // Bloom in quickly, breathe out slowly. Never a hard flash.
      const env = t < 0.22 ? smoothstep(0, 0.22, t) : 1 - smoothstep(0.22, 1, t);
      const size = s.scale * (0.55 + 0.75 * env);
      s.sprite.scale.set(size, size, 1);
      s.material.opacity = env * 0.85;
    }
  });

  return (
    <group name="glints">
      {slots.map((s, i) => (
        <primitive key={i} object={s.sprite} />
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

/** Spec §99: this framing is what makes the tank fill 85–90% of the projection. */
function CameraRig() {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);

  useEffect(() => {
    // Must match the <Canvas camera> prop in screen/[roomId]/page.tsx — this
    // effect re-asserts the pose after resizes and would otherwise silently
    // undo the raised framing chosen for fish readability.
    camera.position.set(0, 4.35, 9.15);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, -0.55, 0);
    camera.updateProjectionMatrix();
  }, [camera, size]);

  return null;
}

// ---------------------------------------------------------------------------
// Frame driver
// ---------------------------------------------------------------------------

interface FishClock {
  /** Render time handed to the fish buffer, in the same base as 'nowSeconds()'. */
  t: number;
  started: boolean;
  /** Wall time the current slow-motion beat began, or 0. */
  slowFrom: number;
}

interface GhostSeat {
  number: number;
  x: number;
  z: number;
}

interface DriverContext {
  api: ScreenSocketApi;
  fish: FishSnapshot[];
  wires: Map<number, PoiWire>;
  seen: Set<number>;
  /** Seats whose paper has torn and is being replaced, with where it happened. */
  ghosts: Map<number, GhostSeat>;
  clock: FishClock;
  onSeatsChanged(seats: number[]): void;
  onGhostsChanged(ghosts: GhostSeat[]): void;
}

/** Fraction of the beat spent ramping INTO slow motion. The rest ramps back out. */
const SLOW_RAMP_IN = 0.16;
/** Ceiling on the catch-up rate. Above about 1.3 the school visibly fast-forwards. */
const MAX_CATCHUP = 0.3;

function SceneDriver({ ctx }: { ctx: DriverContext }) {
  useFrame((_state, delta) => {
    const dt = Math.min(delta, 0.05);
    const now = nowSeconds();

    // ----------------------------------------------------------------- poi
    // Real clock, light smoothing only. This is the number a player feels in
    // their hand, so nothing here is ever deliberately delayed.
    const poi = ctx.api.poiBuffer.sample(now, dt);
    const wires = ctx.wires;
    const seen = ctx.seen;
    seen.clear();
    let seatsChanged = false;

    const ghosts = ctx.ghosts;
    let ghostsChanged = false;

    for (const p of poi) {
      seen.add(p.playerNumber);
      const wire = wires.get(p.playerNumber);
      if (wire) {
        Object.assign(wire, p);
      } else {
        wires.set(p.playerNumber, { ...p });
        seatsChanged = true;
      }

      // A torn poi hides itself while it is being replaced (PoiView handles that), so
      // the seat is held by a ghost outline instead — driven off the authoritative
      // state rather than off the break event, which keeps it correct even for a
      // screen that connected in the middle of a respawn.
      const respawning = p.state === 'Respawning';
      const held = ghosts.has(p.playerNumber);
      if (respawning && !held) {
        ghosts.set(p.playerNumber, { number: p.playerNumber, x: p.x, z: p.z });
        ghostsChanged = true;
      } else if (!respawning && held) {
        ghosts.delete(p.playerNumber);
        ghostsChanged = true;
      }
    }

    for (const key of wires.keys()) {
      if (!seen.has(key)) {
        wires.delete(key);
        seatsChanged = true;
        if (ghosts.delete(key)) ghostsChanged = true;
      }
    }

    if (seatsChanged) {
      ctx.onSeatsChanged([...wires.keys()].sort((a, b) => a - b));
    }
    if (ghostsChanged) {
      ctx.onGhostsChanged([...ghosts.values()].sort((a, b) => a.number - b.number));
    }

    // ---------------------------------------------------------------- fish
    const clock = ctx.clock;
    if (!clock.started) {
      clock.t = now;
      clock.started = true;
    }

    let env = 0;
    if (clock.slowFrom > 0) {
      const u = (now - clock.slowFrom) / CAPTURE.slowMotionSeconds;
      if (u >= 1) {
        clock.slowFrom = 0;
      } else {
        // Eased both ways: a step into or out of slow motion reads as a dropped frame.
        env =
          u < SLOW_RAMP_IN
            ? smoothstep(0, SLOW_RAMP_IN, u)
            : 1 - smoothstep(SLOW_RAMP_IN, 1, u);
      }
    }

    let lag = now - clock.t;
    // A backgrounded tab, or a very long stall: give up on continuity and re-sync.
    if (lag > 1.2 || lag < -0.05) {
      clock.t = now;
      lag = 0;
    }

    // The slow beat leaves the fish clock genuinely behind real time. It has to be
    // paid back, or ten captures in a round would strand the school half a second in
    // the past with nothing left to interpolate between. So once the beat is over the
    // clock runs slightly fast until the debt is gone — exponential, and capped well
    // below anything the eye reads as fast-forward.
    const scale = 1 + (CAPTURE.slowMotionScale - 1) * env;
    const catchUp = env > 0.001 ? 0 : Math.min(lag * 0.9, MAX_CATCHUP);
    clock.t += dt * clamp(scale + catchUp, 0.05, 1.6);
    if (clock.t > now) clock.t = now;

    const sampled = ctx.api.fishBuffer.sample(clock.t);
    const arr = ctx.fish;
    arr.length = sampled.length;
    for (let i = 0; i < sampled.length; i++) arr[i] = sampled[i];
  });

  return null;
}

// ---------------------------------------------------------------------------
// TankScene
// ---------------------------------------------------------------------------

export interface TankSceneProps {
  api: ScreenSocketApi;
  /** 'room.settings.highQuality'. Drives post FX, shader tier and particle budgets. */
  highQuality: boolean;
  /** 'room.settings.poiBreakPenalty' — shows the penalty as a floating number. */
  breakPenalty?: boolean;
}

const colorFor = (playerNumber: number): string =>
  PLAYER_COLORS[(playerNumber - 1 + PLAYER_COLORS.length) % PLAYER_COLORS.length];

export function TankScene({ api, highQuality, breakPenalty = true }: TankSceneProps) {
  const ripple = useRippleField();

  const splashRef = useRef<SplashHandle | null>(null);
  const dropletsRef = useRef<DropletHandle | null>(null);
  const popupsRef = useRef<ScorePopupApi | null>(null);
  const glintsRef = useRef<GlintApi | null>(null);

  const [seats, setSeats] = useState<number[]>([]);
  const [ghosts, setGhosts] = useState<GhostSeat[]>([]);

  const fish = useMemo<FishSnapshot[]>(() => [], []);
  const wires = useMemo(() => new Map<number, PoiWire>(), []);
  const ghostSeats = useMemo(() => new Map<number, GhostSeat>(), []);
  const clock = useMemo<FishClock>(() => ({ t: 0, started: false, slowFrom: 0 }), []);

  const ctx = useMemo<DriverContext>(
    () => ({
      api,
      fish,
      wires,
      seen: new Set<number>(),
      ghosts: ghostSeats,
      clock,
      onSeatsChanged: setSeats,
      onGhostsChanged: setGhosts,
    }),
    [api, fish, wires, ghostSeats, clock],
  );

  // Everything the event handlers touch, gathered so the subscription effect can depend
  // only on the (stable) subscribe functions and never re-run.
  const kit = useRef({ ripple, splashRef, dropletsRef, popupsRef, glintsRef, clock, breakPenalty });
  kit.current = { ripple, splashRef, dropletsRef, popupsRef, glintsRef, clock, breakPenalty };

  const { onSplash, onCapture, onBreak, onDrop, onRespawn, onJoined, onRare } = api;

  useEffect(() => {
    const unsubscribe: Array<() => void> = [];

    // ------------------------------------------------------------------ splash
    unsubscribe.push(
      onSplash((p) => {
        const k = kit.current;
        const spec = RIPPLE_SPEC[p.kind];
        const strength = clamp(p.strength, 0, 1);
        const weight = 0.45 + 0.55 * strength;

        if (!DIAG.noSplashFx && !DIAG.noRipple) {
          k.ripple.addRipple(p.x, p.z, spec.amp * weight, spec.radius);
        }
        if (!DIAG.noSplashFx && !DIAG.noParticles) {
          k.splashRef.current?.spawn(p.x, TANK.surfaceY, p.z, strength, SPLASH_KIND[p.kind]);
        }

        const at = pan(p.x);
        switch (p.kind) {
          case 'ENTER':
            audio.play('poiEnter', { volume: 0.35 + 0.5 * strength, pan: at });
            if (strength > 0.55) audio.play('splashSmall', { volume: 0.4 * strength, pan: at });
            break;
          case 'EXIT':
            audio.play('poiExit', { volume: 0.35 + 0.45 * strength, pan: at });
            break;
          case 'CAPTURE':
            audio.play('splashBig', { volume: 0.55 + 0.35 * strength, pan: at });
            break;
          case 'POI_COLLIDE':
            audio.play('splashSmall', { volume: 0.22 + 0.24 * strength, pan: at, rate: 1.18 });
            break;
          case 'BREAK':
            audio.play('splashBig', { volume: 0.6 + 0.3 * strength, pan: at, rate: 0.9 });
            break;
          case 'FISH_SURFACE':
            audio.play('splashSmall', { volume: 0.1 + 0.16 * strength, pan: at, rate: 1.35 });
            break;
        }
      }),
    );

    // ----------------------------------------------------------------- capture
    unsubscribe.push(
      onCapture((p) => {
        const k = kit.current;
        const data = getFishData(p.fishType);
        const rare = data.rarity !== 'Common';
        const at = pan(p.x);

        // The slow beat: fish only. The poi clock is untouched (spec §79).
        k.clock.slowFrom = nowSeconds();

        // The server also sends a CAPTURE splash event, and 'onSplash' has already
        // rippled the water for it. This burst adds the part a flat XZ splash cannot
        // express: it is thrown from the paper's real height, where the fish actually
        // broke the surface. No second ripple — two impulses would stack into a wave.
        if (!DIAG.noSplashFx && !DIAG.noParticles) {
          k.splashRef.current?.spawn(p.x, p.y, p.z, rare ? 1 : 0.82, 'capture');
          // Water shedding off the paper that just came up.
          k.dropletsRef.current?.spawn(p.x, Math.max(p.y, 0.2), p.z, rare ? 20 : 14, POI.paperRadius);
          k.popupsRef.current?.spawn(
            p.x,
            Math.max(p.y, 0.35),
            p.z,
            `+${p.score}`,
            rare ? '#ffe089' : '#fdf6e6',
          );
          k.glintsRef.current?.spawn(
            p.x,
            Math.max(p.y, 0.3),
            p.z,
            rare ? data.colorBody : colorFor(p.playerNumber),
            rare ? 2.1 : 1.4,
            rare ? 1.0 : 0.7,
          );
        }

        audio.play(rare ? 'captureRare' : 'capture', { volume: rare ? 1 : 0.85, pan: at });
      }),
    );

    // ------------------------------------------------------------------- break
    unsubscribe.push(
      onBreak((p) => {
        const k = kit.current;
        const at = pan(p.x);

        // As with a capture: the water ripple belongs to the BREAK splash event, this
        // is the heavier burst at the height the paper actually gave way.
        if (!DIAG.noSplashFx && !DIAG.noParticles) {
          k.splashRef.current?.spawn(p.x, p.y, p.z, 1, 'break');
          k.dropletsRef.current?.spawn(p.x, Math.max(p.y, 0.15), p.z, 26, POI.paperRadius * 1.4);
          if (k.breakPenalty && p.penalty > 0) {
            k.popupsRef.current?.spawn(p.x, Math.max(p.y, 0.35), p.z, `-${p.penalty}`, '#ff8f7a');
          }
        }

        audio.play('poiTear', { volume: 0.75, pan: at });
        audio.play('poiBreak', { volume: 0.95, pan: at });
      }),
    );

    // -------------------------------------------------------------------- drop
    unsubscribe.push(
      onDrop((p) => {
        const k = kit.current;
        const at = pan(p.x);
        // A fish coming off the paper falls back in: the surface is pushed DOWN.
        if (!DIAG.noSplashFx && !DIAG.noParticles) {
          k.splashRef.current?.spawn(p.x, Math.max(p.y, 0.05), p.z, 0.45, 'fish');
        }
        if (!DIAG.noSplashFx && !DIAG.noRipple) {
          k.ripple.addRipple(p.x, p.z, -0.16, 0.34);
        }
        audio.play('drop', { volume: 0.55, pan: at });
      }),
    );

    // ----------------------------------------------------------------- respawn
    unsubscribe.push(
      onRespawn((p) => {
        const x = POI_START_X[(p.playerNumber - 1) % POI_START_X.length] ?? 0;
        audio.play('poiRespawn', { volume: 0.7, pan: pan(x) });
        kit.current.glintsRef.current?.spawn(
          x,
          POI.hoverY,
          0,
          colorFor(p.playerNumber),
          1.6,
          0.75,
        );
      }),
    );

    // ------------------------------------------------------------------ joined
    unsubscribe.push(
      onJoined((p) => {
        const x = POI_START_X[(p.playerNumber - 1) % POI_START_X.length] ?? 0;
        audio.play('join', { volume: 0.8, pan: pan(x) });
        kit.current.ripple.addRipple(x, 0, 0.24, 0.7);
        kit.current.glintsRef.current?.spawn(x, POI.hoverY, 0, p.color || colorFor(p.playerNumber), 1.8, 0.9);
      }),
    );

    // -------------------------------------------------------------------- rare
    // Spec §108: no banner, no callout, no sound. A glint, and it is gone.
    unsubscribe.push(
      onRare((p) => {
        const data = getFishData(p.fishType);
        kit.current.glintsRef.current?.spawn(p.x, p.y, p.z, data.colorSecondary, 1.15, 1.25);
      }),
    );

    return () => {
      for (const off of unsubscribe) off();
    };
  }, [onSplash, onCapture, onBreak, onDrop, onRespawn, onJoined, onRare]);

  // ------------------------------------------------------------------ warm-up
  // Venue report: the screen flashed black the instant a poi first touched the
  // water. That instant is when the splash, ring, droplet and popup shaders all
  // compile for the first time — a main-thread stall long enough for the
  // compositor to present an unfinished frame. So everything is compiled and
  // exercised ONCE, invisibly, right after the scene mounts, and again whenever
  // a poi joins (its paper material is new too).
  const gl3 = useThree((st) => st.gl);
  const scene3 = useThree((st) => st.scene);
  const camera3 = useThree((st) => st.camera);
  const warmedRef = useRef(false);
  const seatCount = seats.length;

  useEffect(() => {
    // Two frames in, so every pool and material exists.
    const id = window.setTimeout(() => {
      try {
        gl3.compile(scene3, camera3);
      } catch {
        /* a compile failure surfaces on first use instead — never fatal */
      }
      if (!warmedRef.current) {
        warmedRef.current = true;
        // One silent shot from every effect system, far below the tank floor:
        // fills the instance buffers, runs the update paths, compiles anything
        // gl.compile missed (instanced attributes only bind on first draw).
        const k = kit.current;
        const kinds = ['enter', 'exit', 'capture', 'break', 'fish', 'collide'] as const;
        for (const kind of kinds) k.splashRef.current?.spawn(0, -30, 0, 0.02, kind);
        k.dropletsRef.current?.spawn(0, -30, 0, 2, 0.1);
        k.popupsRef.current?.spawn(0, -30, 0, ' ', '#000000');
        k.glintsRef.current?.spawn(0, -30, 0, '#000000', 0.01, 0.05);
        k.ripple.addRipple(0, 0, 0.001, 0.2);
      }
    }, 120);
    return () => window.clearTimeout(id);
  }, [gl3, scene3, camera3, seatCount]);

  const particleQuality = highQuality ? 'high' : 'medium';

  return (
    <>
      {/* Registered first, so every consumer below reads THIS frame's samples. */}
      <SceneDriver ctx={ctx} />
      <CameraRig />

      <FestivalLighting quality={highQuality ? 'high' : 'medium'} />
      <FestivalStall />
      <Lanterns lights lightStride={highQuality ? 1 : 2} />

      <Underwater />
      <Bubbles count={highQuality ? 180 : 96} vents={highQuality ? 14 : 9} />
      <Caustics rippleTexture={ripple.texture} quality={highQuality} />

      <FishSchool fish={fish} quality={highQuality ? 'high' : 'low'} />

      {seats.map((n) => {
        const wire = wires.get(n);
        if (!wire) return null;
        return (
          <PoiView key={n} poi={wire} color={colorFor(n)} playerNumber={n} label={String(n)} />
        );
      })}

      {ghosts.map((g) => (
        <PoiGhost key={g.number} x={g.x} z={g.z} color={colorFor(g.number)} />
      ))}

      <SplashSystem ref={splashRef} quality={particleQuality} />
      <Droplets ref={dropletsRef} capacity={320} />
      <ScorePopups apiRef={popupsRef} />
      <Glints apiRef={glintsRef} />

      {/* The water presents the frame unless the composer is mounted to do it.
          (?fx=0 unmounts the composer, so the water must present then too.) */}
      <WaterSurface
        rippleField={ripple}
        quality={highQuality}
        renderScene={!highQuality || DIAG.noPostFx}
      />

      {highQuality && !DIAG.noPostFx ? <Effects enabled quality="high" /> : null}
    </>
  );
}

export default TankScene;
