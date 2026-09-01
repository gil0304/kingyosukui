import type {
  CapturedFish,
  ControllerState,
  FishType,
  GameResult,
  PlayerId,
  PlayerNumber,
  RoomPublicState,
  RoomSettings,
  RoomState,
} from '@/types';

/** Wire event names. Kept as consts so both ends cannot drift. */
export const EV = {
  // --- client -> server -------------------------------------------------
  SCREEN_JOIN: 'screen:join',
  ADMIN_JOIN: 'admin:join',
  PLAYER_JOIN: 'player:join',
  PLAYER_LEAVE: 'player:leave',
  PLAYER_READY: 'player:ready',
  CONTROLLER_INPUT: 'c:in',
  CONTROLLER_CALIBRATED: 'controller:calibrated',
  ADMIN_COMMAND: 'admin:cmd',
  PING: 'net:ping',

  // --- server -> client -------------------------------------------------
  ROOM_STATE: 'room:state',
  PHASE: 'game:phase',
  SNAPSHOT_FISH: 's:f',
  SNAPSHOT_POI: 's:p',
  EVENT_CAPTURE: 'ev:capture',
  EVENT_DROP: 'ev:drop',
  EVENT_POI_BREAK: 'ev:break',
  EVENT_POI_RESPAWN: 'ev:respawn',
  EVENT_SPLASH: 'ev:splash',
  EVENT_PLAYER_JOINED: 'ev:joined',
  EVENT_PLAYER_LEFT: 'ev:left',
  EVENT_RARE_SPAWN: 'ev:rare',
  BOWL_STATE: 'bowl:state',
  RESULT: 'game:result',
  CALIBRATE_REQUEST: 'controller:calibrate',
  PONG: 'net:pong',
  ERROR: 'net:error',
} as const;

// ---------------------------------------------------------------------------
// client -> server payloads
// ---------------------------------------------------------------------------

export interface ScreenJoinPayload {
  roomId: string;
}

export interface PlayerJoinPayload {
  roomId: string;
  name?: string;
  /** Returned by a previous join; lets a reloaded phone reclaim its seat. */
  resumeToken?: string;
}

export interface PlayerJoinAck {
  ok: boolean;
  reason?: 'ROOM_FULL' | 'ROOM_NOT_FOUND' | 'IN_PROGRESS';
  playerId?: PlayerId;
  playerNumber?: PlayerNumber;
  color?: string;
  resumeToken?: string;
  /** True when the player must wait for the next round (spec §85). */
  spectating?: boolean;
  room?: RoomPublicState;
}

export interface PlayerReadyPayload {
  controllerReady: boolean;
  status?: {
    hasOrientation: boolean;
    hasMotion: boolean;
    gravityOnly: boolean;
  };
}

export interface ControllerCalibratedPayload {
  ok: boolean;
}

export type AdminCommand =
  | { type: 'START' }
  | { type: 'RESET' }
  | { type: 'SKIP_TO_RESULT' }
  | { type: 'SETTINGS'; settings: Partial<RoomSettings> }
  | { type: 'KICK'; playerId: PlayerId }
  | { type: 'ADD_BOT'; count?: number }
  | { type: 'CLEAR_BOTS' }
  /** Drop every player, including ones whose browser tab is long gone. */
  | { type: 'CLEAR_PLAYERS' };

// ---------------------------------------------------------------------------
// server -> client payloads
// ---------------------------------------------------------------------------

export interface PhasePayload {
  state: RoomState;
  /** Server ms timestamp. */
  startedAt: number;
  endsAt: number | null;
  timeRemaining: number;
  /** Integer countdown value during CALIBRATION / COUNTDOWN, else null. */
  count: number | null;
}

export interface CapturePayload {
  playerId: PlayerId;
  playerNumber: PlayerNumber;
  fishId: number;
  fishType: FishType;
  /** Japanese label, e.g. 金色金魚. */
  fishLabel: string;
  rarity: string;
  score: number;
  totalScore: number;
  fishCount: number;
  /** Where it happened, for the screen effect. */
  x: number;
  y: number;
  z: number;
  capturedFish: CapturedFish;
  serverTime: number;
}

export interface DropPayload {
  playerId: PlayerId;
  playerNumber: PlayerNumber;
  fishId: number;
  fishType: FishType;
  reason: 'TILT' | 'BREAK' | 'TOO_FAST' | 'TIMEUP';
  x: number;
  y: number;
  z: number;
}

export interface PoiBreakPayload {
  playerId: PlayerId;
  playerNumber: PlayerNumber;
  x: number;
  y: number;
  z: number;
  droppedFish: number;
  penalty: number;
  respawnInSeconds: number;
}

export interface PoiRespawnPayload {
  playerId: PlayerId;
  playerNumber: PlayerNumber;
}

export type SplashKind =
  | 'ENTER'
  | 'EXIT'
  | 'FISH_SURFACE'
  | 'CAPTURE'
  | 'POI_COLLIDE'
  | 'BREAK';

export interface SplashPayload {
  kind: SplashKind;
  x: number;
  z: number;
  /** 0..1 */
  strength: number;
  playerNumber: number;
}

export interface PlayerJoinedPayload {
  playerId: PlayerId;
  playerNumber: PlayerNumber;
  name: string;
  color: string;
}

export interface PlayerLeftPayload {
  playerId: PlayerId;
  playerNumber: PlayerNumber;
}

export interface RareSpawnPayload {
  fishId: number;
  fishType: FishType;
  x: number;
  y: number;
  z: number;
}

export interface BowlStatePayload {
  playerId: PlayerId;
  playerNumber: PlayerNumber;
  score: number;
  capturedFish: CapturedFish[];
  poiDurability: number;
  poiWetness: number;
  poiState: string;
  /** Seconds until a broken poi returns, or 0. */
  respawnIn: number;
  connected: boolean;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

export interface PongPayload {
  clientTime: number;
  serverTime: number;
}

/** Type-safe map of every server -> client event. */
export interface ServerToClientEvents {
  [EV.ROOM_STATE]: (p: RoomPublicState) => void;
  [EV.PHASE]: (p: PhasePayload) => void;
  [EV.SNAPSHOT_FISH]: (buf: ArrayBuffer) => void;
  [EV.SNAPSHOT_POI]: (buf: ArrayBuffer) => void;
  [EV.EVENT_CAPTURE]: (p: CapturePayload) => void;
  [EV.EVENT_DROP]: (p: DropPayload) => void;
  [EV.EVENT_POI_BREAK]: (p: PoiBreakPayload) => void;
  [EV.EVENT_POI_RESPAWN]: (p: PoiRespawnPayload) => void;
  [EV.EVENT_SPLASH]: (p: SplashPayload) => void;
  [EV.EVENT_PLAYER_JOINED]: (p: PlayerJoinedPayload) => void;
  [EV.EVENT_PLAYER_LEFT]: (p: PlayerLeftPayload) => void;
  [EV.EVENT_RARE_SPAWN]: (p: RareSpawnPayload) => void;
  [EV.BOWL_STATE]: (p: BowlStatePayload) => void;
  [EV.RESULT]: (p: GameResult) => void;
  [EV.CALIBRATE_REQUEST]: (p: { durationSeconds: number }) => void;
  [EV.PONG]: (p: PongPayload) => void;
  [EV.ERROR]: (p: ErrorPayload) => void;
}

export interface ClientToServerEvents {
  [EV.SCREEN_JOIN]: (p: ScreenJoinPayload, ack?: (r: { ok: boolean }) => void) => void;
  [EV.ADMIN_JOIN]: (p: ScreenJoinPayload, ack?: (r: { ok: boolean }) => void) => void;
  [EV.PLAYER_JOIN]: (p: PlayerJoinPayload, ack?: (r: PlayerJoinAck) => void) => void;
  [EV.PLAYER_LEAVE]: () => void;
  [EV.PLAYER_READY]: (p: PlayerReadyPayload) => void;
  [EV.CONTROLLER_INPUT]: (buf: ArrayBuffer) => void;
  [EV.CONTROLLER_CALIBRATED]: (p: ControllerCalibratedPayload) => void;
  [EV.ADMIN_COMMAND]: (p: AdminCommand) => void;
  [EV.PING]: (p: { clientTime: number }) => void;
}

/** Re-exported so the server can type its poi input map. */
export type { ControllerState };
