# MODULE CONTRACTS — 巨大デジタル金魚すくい

Every module below is implemented independently. **These signatures are frozen.**
If you implement one of these modules, export exactly these names with exactly these
shapes. If you consume one, assume exactly these shapes.

Path alias: `@/*` → `src/*`, `@server/*` → `server/*`.

## Already written (DO NOT MODIFY — read and use)

- `src/game/core/constants.ts` — `TANK, FISH_BOUNDS, POI_BOUNDS, POI, WETNESS, DURABILITY, CAPTURE, GAME, NET, PLAYER_COLORS, PLAYER_COLOR_NAMES, POI_START_X`
- `src/game/core/math.ts` — `Vec3, vec3, vadd, vsub, vscale, vaddScaled, vlen, vlenSq, vdist, vdistSq, vnormalize, vclampLength, vlerp, vcopy, vset, clamp, clamp01, lerp, inverseLerp, remap, smoothstep, damp, dampVec3, springDamp, wrapAngle, angleLerp, rotateTowards, createRng, Rng, noise1, nowSeconds, TAU, DEG2RAD, RAD2DEG`
- `src/types/*` (barrel `@/types`) — `ControllerState, ControllerStateExt, SensorSample, CalibrationData, GesturePhase, GestureEvent, ControllerStatus, FishData, FishType, FishRarity, FishAnimState, FishSnapshot, FISH_TYPE_ORDER, fishTypeIndex, fishTypeFromIndex, fishAnimIndex, fishAnimFromIndex, Player, PlayerPublicState, PlayerBowlState, CapturedFish, PoiWetnessStage, PoiVerticalState, POI_VERTICAL_STATES, poiStateIndex, poiStateFromIndex, wetnessStage, RankedPlayer, Award, GameResult, Room, RoomState, RoomSettings, RoomPublicState, RoomId, PlayerId, FishId, PlayerNumber`
- `src/network/protocol/events.ts` — `EV`, all payload interfaces, `ServerToClientEvents`, `ClientToServerEvents`
- `src/network/protocol/codec.ts` — `PACKET, PROTOCOL_VERSION, encodeFishPacket, decodeFishPacket, FishWireSource, FishPacket, encodePoiPacket, decodePoiPacket, PoiWire, PoiPacket, encodeInput, decodeInput, InputWire, toWireSource, packetSizes`
- `src/game/fish/fishTypes.ts` — `FISH_CATALOG, FISH_TYPES, getFishData, RARITY_ORDER, RARITY_LABEL, isRare, pickFishType, buildSpawnList`
- `src/game/scoring/scoring.ts` — `bestFishOf, rarityCount, totalScore, rankPlayers, computeAwards, buildResult, formatScore, ScoringInput`

**Purity rule:** these files and every module marked `[PURE]` below must NOT import
`three`, `react`, or any browser-only global — they run inside the Node game server.

---

## [PURE] `src/controller/filtering/filters.ts`

```ts
export class LowPassFilter {
  constructor(alpha: number);          // 0..1, higher = more responsive
  next(v: number): number;
  reset(v?: number): void;
  get value(): number;
  get initialized(): boolean;
}
export class OneEuroFilter {
  constructor(opts?: { minCutoff?: number; beta?: number; dCutoff?: number });
  next(v: number, dt: number): number;
  reset(): void;
}
export class Vec3LowPass {
  constructor(alpha: number);
  next(x: number, y: number, z: number): { x: number; y: number; z: number };
  reset(): void;
  readonly x: number; readonly y: number; readonly z: number;
}
/** Zero inside `dz`, then ramps smoothly to 1 at `max` (no step at the edge). */
export function softDeadZone(v: number, dz: number, max?: number): number;
export class Cooldown {
  constructor(seconds: number);
  ready(t: number): boolean;
  trigger(t: number): void;
  tryTrigger(t: number): boolean;
  reset(): void;
}
/** Tracks the max |value| seen since the last reset, with optional decay. */
export class PeakTracker {
  constructor(decayPerSecond?: number);
  push(v: number, dt: number): number;
  reset(): void;
  get peak(): number;
}
/** Rolling variance over the last N samples — used for "is the hand still?" */
export class Stillness {
  constructor(windowSize?: number);
  push(v: number): void;
  get variance(): number;
  get isStill(): boolean;   // variance below a small threshold
  reset(): void;
}
```

## [PURE] `src/controller/calibration/calibrator.ts`

```ts
import type { CalibrationData, SensorSample } from '@/types';
export class Calibrator {
  begin(): void;                       // start collecting
  addSample(s: SensorSample): void;    // no-op unless collecting
  finish(): CalibrationData | null;    // averages, stores, stops collecting
  cancel(): void;
  get collecting(): boolean;
  get sampleCount(): number;
  get data(): CalibrationData | null;
  setData(d: CalibrationData | null): void;
  /** Very slow neutral drift correction. `moving` suppresses it entirely. */
  updateDrift(s: SensorSample, dt: number, moving: boolean): void;
  /** Calibrated tilt in RADIANS. tiltX = roll (right +), tiltY = pitch (forward -), tiltZ = yaw delta. */
  apply(s: SensorSample): { tiltX: number; tiltY: number; tiltZ: number };
}
/** Averages a set of samples without needing an instance (used by tests). */
export function averageCalibration(samples: readonly SensorSample[]): CalibrationData | null;
```

## [PURE] `src/controller/gestures/gestureDetector.ts`

```ts
import type { GestureEvent, GesturePhase } from '@/types';
export interface GestureOutput {
  phase: GesturePhase;
  isSubmerging: boolean;
  isLifting: boolean;
  handOffsetY: number;      // metres, leaky-integrated, + = raised
  handVelocityY: number;    // m/s, + = lifting
  liftPeakAccel: number;    // m/s² peak during current lift
  shake: number;            // 0..1
  events: GestureEvent[];   // reused array, valid until next update()
}
export class GestureDetector {
  constructor(opts?: Partial<GestureTuning>);
  /** `verticalAcceleration` is the world-up component in m/s² (gravity removed). */
  update(verticalAcceleration: number, dt: number, t: number, poiInWater: boolean): GestureOutput;
  reset(): void;
  get output(): GestureOutput;
}
export interface GestureTuning {
  submergeAccel: number; submergeHold: number; submergeOffset: number;
  liftAccel: number; liftVelocity: number; liftHold: number;
  leakTime: number; stillnessResetTime: number; cooldown: number;
}
export const DEFAULT_GESTURE_TUNING: GestureTuning;
```

## `src/controller/sensors/permission.ts` (browser)

```ts
export type PermissionResult = 'granted' | 'denied' | 'unsupported' | 'unknown';
export interface MotionCapabilities {
  hasOrientation: boolean; hasMotion: boolean; needsPermission: boolean; secureContext: boolean;
}
export function detectMotionCapabilities(): MotionCapabilities;
/** MUST be called from inside a user gesture (iOS 13+). */
export function requestMotionPermission(): Promise<PermissionResult>;
```

## `src/controller/sensors/sensorAdapter.ts` (browser)

```ts
import type { CalibrationData, ControllerStateExt, ControllerStatus, SensorSample } from '@/types';
export interface SensorAdapterOptions {
  playerId: string;
  /** Debug mode: drive the state from keyboard/mouse instead of sensors. */
  debug?: boolean;
}
export class SensorAdapter {
  constructor(opts: SensorAdapterOptions);
  /** Attaches listeners. Assumes permission is already granted. */
  start(): void;
  stop(): void;
  get status(): ControllerStatus;
  get state(): ControllerStateExt;         // last computed
  get lastSample(): SensorSample | null;
  /** Compute a fresh ControllerStateExt. Call once per animation frame. */
  sample(nowSeconds: number): ControllerStateExt;
  beginCalibration(): void;
  finishCalibration(): boolean;
  get calibration(): CalibrationData | null;
  /** Server tells us whether our poi is actually in the water. */
  setPoiInWater(v: boolean): void;
  setPlayerId(id: string): void;
}
```
Requirements: handle `screen.orientation.angle`; synthesize linear acceleration by
low-pass gravity subtraction when `event.acceleration` is null (`status.gravityOnly`);
compute the world-up acceleration component using the estimated gravity direction,
gated by rotation rate; derive tilt from the GRAVITY VECTOR (not beta/gamma) relative
to the calibrated neutral grip; apply `OneEuroFilter`, then `softDeadZone` (±2.2°) and
the progressive response curve |v|^1.7 with ±40° full-scale (exported as
`mapTiltToAxis`, with `gravityAngles` / `gravityHemisphere` for tests); own a
`Calibrator` (yaw + drift bookkeeping) and a `GestureDetector`.

## [PURE] `src/game/fish/boids.ts`

```ts
export interface BoidWeights { separation: number; alignment: number; cohesion: number;
  separationRadius: number; neighborRadius: number; }
export const DEFAULT_BOID_WEIGHTS: BoidWeights;
/** Uniform-grid spatial hash over a fixed AABB. Reused every tick, no allocation. */
export class SpatialHash {
  constructor(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, cell: number);
  clear(): void;
  insert(index: number, x: number, y: number, z: number): void;
  /** Fills `out` with indices in cells overlapping the sphere; returns the count. */
  query(x: number, y: number, z: number, radius: number, out: Int32Array): number;
}
```

## [PURE] `src/game/fish/fishSimulation.ts`

```ts
import type { FishAnimState, FishData, FishType } from '@/types';
import type { FishWireSource } from '@/network/protocol/codec';
import type { Vec3 } from '@/game/core/math';

export interface PoiQuery {
  playerNumber: number; x: number; y: number; z: number;
  radius: number; inWater: boolean; active: boolean; speed: number;
}
export class FishSimulation {
  constructor(count: number, seed: number);
  get count(): number;                    // live fish
  reset(count: number, seed: number): void;
  update(dt: number, poi: readonly PoiQuery[]): void;
  /** Reused array — do not retain across ticks. */
  getWire(): FishWireSource[];

  has(id: number): boolean;
  isSwimming(id: number): boolean;        // state === IdleSwim/FastSwim/Escape
  getType(id: number): FishType;
  getData(id: number): FishData;
  getWeight(id: number): number;
  getPosition(id: number, out: Vec3): Vec3;
  setAnim(id: number, anim: FishAnimState): void;
  /** Mark a fish as sitting on a poi (or release it). */
  setCarried(id: number, playerNumber: number): void;
  releaseCarried(id: number, dropVelocityY?: number): void;
  /** Drive a carried fish's transform from the poi. */
  placeCarried(id: number, x: number, y: number, z: number, yaw: number): void;
  /** Remove after a successful capture and spawn a replacement to keep the school full. */
  captureAndReplace(id: number): void;
  /** Fish ids currently Swimming inside the cylinder (centre, radius, +height). */
  queryCylinder(x: number, y: number, z: number, radius: number, height: number, out: number[]): number[];
  /** Everyone rises and calms down at TIME UP (spec §102). */
  setCalmMode(v: boolean): void;
  /** Ids of Legendary/SuperRare fish spawned since the last call. */
  drainRareSpawns(): { id: number; type: FishType; x: number; y: number; z: number }[];
}
```

## [PURE] `src/game/poi/durability.ts`

```ts
export function wetnessModifier(wetness: number): number;            // 1 + w²·factor
export function computeLoad(fishWeight: number, liftAccel: number, wetness: number): number;
export interface DurabilityContext {
  inWater: boolean; lifting: boolean; liftAccel: number;
  carriedWeight: number; wetness: number;
}
/** Returns the damage to subtract this frame. */
export function durabilityDamage(ctx: DurabilityContext, dt: number): number;
export function updateWetness(wetness: number, inWater: boolean, dt: number): number;
/** 0..1 visual hole size derived from durability. */
export function tearAmount(durability: number): number;
```

## [PURE] `src/game/poi/poiSimulation.ts`

```ts
import type { PoiVerticalState } from '@/types';
import type { PoiWire } from '@/network/protocol/codec';

export interface PoiInput {
  x: number; y: number;                    // normalised −1..1 targets
  tiltX: number; tiltY: number; tiltZ: number;
  verticalAcceleration: number;
  handOffsetY: number; handVelocityY: number; liftPeakAccel: number;
  isSubmerging: boolean; isLifting: boolean;
  connected: boolean;
}
export type PoiEventType =
  | 'ENTER_WATER' | 'EXIT_WATER' | 'LIFT_START' | 'LIFT_RESOLVED'
  | 'BROKE' | 'RESPAWNED' | 'COLLIDE';
export interface PoiEvent { type: PoiEventType; strength: number; }

export class PoiSimulation {
  constructor(playerNumber: number, startX: number);
  readonly playerNumber: number;
  x: number; y: number; z: number;
  tiltX: number; tiltZ: number; spin: number; vy: number;
  wetness: number; durability: number; tear: number;
  state: PoiVerticalState;
  /** Fish ids currently resting on the paper. */
  readonly carried: number[];
  /** Sum of the weights of carried fish — set by the capture system each tick. */
  carriedWeight: number;
  /** Set true while the lift is resolving so the capture system can settle it. */
  get inWater(): boolean;
  get active(): boolean;                   // not Broken/Respawning and connected
  get liftAccel(): number;

  setInput(i: PoiInput): void;
  setDisconnected(): void;
  update(dt: number, t: number): readonly PoiEvent[];
  reset(startX: number): void;
  forceBreak(): void;
  /** Raise out of the water and stop accepting input (TIME UP, spec §102). */
  parkForTimeUp(): void;
  toWire(): PoiWire;
  /** Soft, non-destructive mutual separation (spec §49). Returns true if they touched. */
  static separate(a: PoiSimulation, b: PoiSimulation, dt: number): boolean;
  /** World position of the paper surface where a carried fish sits. */
  paperPoint(index: number, count: number, out: { x: number; y: number; z: number }): void;
}
```

## [PURE] `src/game/lifecycle/roomLifecycle.ts`

```ts
import type { RoomState } from '@/types';
export interface PhaseInfo { state: RoomState; startedAt: number; endsAt: number | null; }
export interface LifecycleCallbacks { onEnter?(s: RoomState): void; onExit?(s: RoomState): void; }
export class RoomLifecycle {
  constructor(cb?: LifecycleCallbacks);
  get state(): RoomState;
  get startedAt(): number;
  get endsAt(): number | null;
  timeRemaining(nowMs: number): number;
  /** Integer countdown for CALIBRATION / COUNTDOWN, else null. */
  countdown(nowMs: number): number | null;
  to(state: RoomState, nowMs: number, durationSeconds?: number): void;
  /** Advances automatically when the current phase expires. Returns true on change. */
  tick(nowMs: number): boolean;
  phase(nowMs: number): PhaseInfo;
}
export function nextAutoState(s: RoomState): RoomState | null;
```

## `src/network/state/snapshotBuffer.ts` (browser)

```ts
import type { FishSnapshot } from '@/types';
import type { PoiWire } from '@/network/protocol/codec';
export interface InterpolatedFish extends FishSnapshot {}
export class FishSnapshotBuffer {
  push(buf: ArrayBuffer, nowSeconds: number): void;
  /** Interpolated fish at `now - NET.fishInterpolationDelay`. Reused array. */
  sample(nowSeconds: number): InterpolatedFish[];
  clear(): void;
  get lastTick(): number;
  get fps(): number;
}
export class PoiStateBuffer {
  push(buf: ArrayBuffer, nowSeconds: number): void;
  /** Lightly smoothed — latency matters more than smoothness here. */
  sample(nowSeconds: number, dt: number): PoiWire[];
  clear(): void;
  get(playerNumber: number): PoiWire | undefined;
}
```

## `src/network/socket/*` (browser React hooks)

```ts
// useScreenSocket.ts
export interface ScreenSocketApi {
  room: RoomPublicState | null;
  phase: PhasePayload | null;
  connected: boolean;
  fishBuffer: FishSnapshotBuffer;
  poiBuffer: PoiStateBuffer;
  /** Effect events since the last drain. */
  onCapture(cb: (p: CapturePayload) => void): () => void;
  onDrop(cb: (p: DropPayload) => void): () => void;
  onBreak(cb: (p: PoiBreakPayload) => void): () => void;
  onRespawn(cb: (p: PoiRespawnPayload) => void): () => void;
  onSplash(cb: (p: SplashPayload) => void): () => void;
  onJoined(cb: (p: PlayerJoinedPayload) => void): () => void;
  onRare(cb: (p: RareSpawnPayload) => void): () => void;
  onResult(cb: (p: GameResult) => void): () => void;
}
export function useScreenSocket(roomId: string): ScreenSocketApi;

// useControllerSocket.ts
export type JoinPhase = 'idle' | 'requesting' | 'joining' | 'joined' | 'error';
export interface ControllerSocketApi {
  connected: boolean;
  joinPhase: JoinPhase;
  error: string | null;
  playerId: string | null;
  playerNumber: number;
  color: string;
  spectating: boolean;
  room: RoomPublicState | null;
  phase: PhasePayload | null;
  bowl: BowlStatePayload | null;
  result: GameResult | null;
  status: ControllerStatus;
  latencyMs: number;
  /** Call from a click handler: asks permission, starts sensors, joins the room. */
  join(): Promise<void>;
  leave(): void;
  onCapture(cb: (p: CapturePayload) => void): () => void;
  onBreak(cb: (p: PoiBreakPayload) => void): () => void;
  /** Live tilt for the bowl water-surface effect (spec §93). */
  readonly adapter: SensorAdapter | null;
}
export function useControllerSocket(roomId: string): ControllerSocketApi;

// useAdminSocket.ts
export interface AdminSocketApi {
  connected: boolean;
  room: RoomPublicState | null;
  send(cmd: AdminCommand): void;
}
export function useAdminSocket(roomId: string): AdminSocketApi;
```

## Server

```ts
// src/network/rooms/GameRoom.ts  (server-only, imports `socket.io`)
export class GameRoom {
  constructor(id: string, io: Server);
  readonly id: string;
  get playerCount(): number;
  get isEmpty(): boolean;
  get lastActivity(): number;
  attachScreen(socket: Socket): void;
  attachAdmin(socket: Socket): void;
  join(socket: Socket, payload: PlayerJoinPayload): PlayerJoinAck;
  handleInput(socketId: string, buf: ArrayBuffer | Buffer): void;
  handleReady(socketId: string, p: PlayerReadyPayload): void;
  handleCalibrated(socketId: string): void;
  handleAdminCommand(cmd: AdminCommand): void;
  detach(socketId: string): void;
  dispose(): void;
}
// src/network/rooms/RoomManager.ts
export class RoomManager {
  constructor(io: Server);
  get(id: string): GameRoom;
  find(id: string): GameRoom | undefined;
  remove(id: string): void;
  list(): GameRoom[];
  bind(socket: Socket): void;   // wires every EV.* handler for one socket
}
// server/lan.ts
export function getLanAddresses(): string[];
export function primaryLanAddress(): string;
// server/certs.ts
export function ensureCertificate(dir: string): { key: string; cert: string };
```

## `src/audio/AudioEngine.ts` (browser)

```ts
export type SfxName =
  | 'poiEnter' | 'poiExit' | 'splashSmall' | 'splashBig' | 'capture' | 'captureRare'
  | 'poiTear' | 'poiBreak' | 'poiRespawn' | 'countdown' | 'start' | 'timeUp'
  | 'drop' | 'join' | 'resultFanfare' | 'bowlDrop';
export class AudioEngine {
  static get instance(): AudioEngine;
  /** Must be called from a user gesture. */
  resume(): Promise<void>;
  get ready(): boolean;
  setEnabled(v: boolean): void;
  setMasterVolume(v: number): void;
  play(name: SfxName, opts?: { volume?: number; pan?: number; rate?: number }): void;
  startAmbience(): void;   // 夏祭りの環境音 + 遠くの祭囃子 (§110, §111)
  stopAmbience(): void;
  dispose(): void;
}
```
All audio is **synthesised with the Web Audio API** (noise + filters + oscillators);
no binary asset files are required. Ambience = filtered noise water bed + a sparse,
distant 祭囃子 motif (pentatonic flute + taiko) at low volume. Never an arcade BGM (§111).
