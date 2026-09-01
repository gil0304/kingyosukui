import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GAME, PLAYER_COLORS, POI, POI_START_X } from '@/game/core/constants';
import {
  decodePoiPacket,
  encodeInput,
  type InputWire,
  type PoiWire,
} from '@/network/protocol/codec';
import {
  EV,
  type BowlStatePayload,
  type PhasePayload,
  type PlayerJoinAck,
  type PlayerJoinedPayload,
  type PlayerLeftPayload,
} from '@/network/protocol/events';
import { GameRoom } from '@/network/rooms/GameRoom';
import type { GameResult, RoomPublicState } from '@/types';

import { FakeIo, FakeSocket, countOf, lastPayloadOf, payloadsOf } from './helpers/fakeIo';

const ROOM = 'TEST';
const ROOM_CHANNEL = `room:${ROOM}`;
const SCREEN_CHANNEL = `screen:${ROOM}`;

/**
 * GameRoom reads the wall clock through BOTH Date.now() and performance.now(),
 * and it ticks on a real setInterval. Vitest's default fake-timer set does not
 * include performance, so it has to be asked for explicitly — without it the
 * room would compute dt = 0 every tick and the simulation would never advance.
 */
const installFakeClock = (): void => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'setImmediate',
      'clearImmediate',
      'Date',
      'performance',
    ],
  });
};

const input = (over: Partial<InputWire> = {}): InputWire => ({
  timeMs: 0,
  x: 0,
  y: 0,
  tiltX: 0,
  tiltY: 0,
  tiltZ: 0,
  verticalAcceleration: 0,
  handOffsetY: 0,
  handVelocityY: 0,
  liftPeakAccel: 0,
  isSubmerging: false,
  isLifting: false,
  shake: 0,
  ...over,
});

describe('GameRoom', () => {
  let io: FakeIo;
  let room: GameRoom;

  const join = (name?: string): { socket: FakeSocket; ack: PlayerJoinAck } => {
    const socket = io.connect();
    const ack = room.join(socket.asSocket, { roomId: ROOM, name });
    return { socket, ack };
  };

  const attachScreen = (): FakeSocket => {
    const socket = io.connect();
    room.attachScreen(socket.asSocket);
    return socket;
  };

  const state = (): RoomPublicState => room.publicState();

  /** Decode the most recent poi snapshot the screen received. */
  const latestPoi = (): PoiWire[] => {
    const buf = lastPayloadOf<ArrayBuffer>(io, EV.SNAPSHOT_POI, SCREEN_CHANNEL);
    expect(buf).toBeDefined();
    const packet = decodePoiPacket(buf!);
    expect(packet).not.toBeNull();
    return packet!.poi;
  };

  /** Run the room forward to the start of PLAYING. */
  const runToPlaying = (): void => {
    room.handleAdminCommand({ type: 'START' });
    vi.advanceTimersByTime(GAME.calibrationSeconds * 1000 + 100);
    vi.advanceTimersByTime(GAME.countdownSeconds * 1000 + 100);
    expect(state().state).toBe('PLAYING');
  };

  beforeEach(() => {
    installFakeClock();
    io = new FakeIo();
    room = new GameRoom(ROOM, io.asServer);
  });

  afterEach(() => {
    room.dispose();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // membership
  // -------------------------------------------------------------------------

  it('seats the first player and announces them to the room', () => {
    const { socket, ack } = join('あかり');

    expect(ack.ok).toBe(true);
    expect(ack.reason).toBeUndefined();
    expect(ack.playerNumber).toBe(1);
    expect(ack.color).toBe(PLAYER_COLORS[0]);
    expect(ack.spectating).toBe(false);
    expect(typeof ack.playerId).toBe('string');
    expect(typeof ack.resumeToken).toBe('string');
    expect(ack.room?.id).toBe(ROOM);
    expect(socket.rooms.has(ROOM_CHANNEL)).toBe(true);

    const joined = payloadsOf<PlayerJoinedPayload>(io, EV.EVENT_PLAYER_JOINED, ROOM_CHANNEL);
    expect(joined).toHaveLength(1);
    expect(joined[0].playerNumber).toBe(1);
    expect(joined[0].playerId).toBe(ack.playerId);
    expect(joined[0].name).toBe('あかり');
    expect(joined[0].color).toBe(PLAYER_COLORS[0]);

    expect(room.playerCount).toBe(1);
    expect(room.isEmpty).toBe(false);
  });

  it('hands out seats 2 and 3, and reuses the seat of a player who left', () => {
    const a = join('A');
    const b = join('B');
    const c = join('C');
    expect([a.ack.playerNumber, b.ack.playerNumber, c.ack.playerNumber]).toEqual([1, 2, 3]);
    expect(b.ack.color).toBe(PLAYER_COLORS[1]);
    expect(c.ack.color).toBe(PLAYER_COLORS[2]);

    room.handleAdminCommand({ type: 'KICK', playerId: b.ack.playerId as string });
    expect(state().players.map((p) => p.number)).toEqual([1, 3]);

    const left = payloadsOf<PlayerLeftPayload>(io, EV.EVENT_PLAYER_LEFT, ROOM_CHANNEL);
    expect(left.map((p) => p.playerId)).toEqual([b.ack.playerId]);

    // The empty seat is filled again rather than pushing everyone up a number.
    const d = join('D');
    expect(d.ack.playerNumber).toBe(2);
    expect(d.ack.color).toBe(PLAYER_COLORS[1]);
    expect(d.ack.playerId).not.toBe(b.ack.playerId);
    expect(state().players.map((p) => p.number)).toEqual([1, 2, 3]);
  });

  it('refuses a join when every seat is taken', () => {
    room.handleAdminCommand({ type: 'SETTINGS', settings: { maxPlayers: 1 } });

    const first = join('A');
    expect(first.ack.ok).toBe(true);

    const second = join('B');
    expect(second.ack.ok).toBe(false);
    expect(second.ack.reason).toBe('ROOM_FULL');
    expect(second.ack.playerId).toBeUndefined();
    expect(second.ack.playerNumber).toBeUndefined();

    expect(room.playerCount).toBe(1);
    expect(countOf(io, EV.EVENT_PLAYER_JOINED, ROOM_CHANNEL)).toBe(1);
  });

  it('reclaims the same seat with a resume token after a reload (spec §84)', () => {
    room.handleAdminCommand({ type: 'SETTINGS', settings: { fishCount: GAME.minFishCount } });
    attachScreen();
    const first = join('ゆう');
    const playerId = first.ack.playerId;
    const token = first.ack.resumeToken as string;

    room.detach(first.socket.id);
    expect(state().players[0].connected).toBe(false);

    const socket = io.connect();
    const ack = room.join(socket.asSocket, { roomId: ROOM, resumeToken: token });

    expect(ack.ok).toBe(true);
    expect(ack.playerId).toBe(playerId);
    expect(ack.playerNumber).toBe(first.ack.playerNumber);
    expect(ack.color).toBe(first.ack.color);
    expect(ack.resumeToken).toBe(token);
    expect(socket.rooms.has(ROOM_CHANNEL)).toBe(true);

    // No second seat was consumed, and nobody was announced twice.
    expect(state().players).toHaveLength(1);
    expect(state().players[0].connected).toBe(true);
    expect(countOf(io, EV.EVENT_PLAYER_JOINED, ROOM_CHANNEL)).toBe(1);

    // The reconnect also cancels the pending removal.
    vi.advanceTimersByTime((GAME.reconnectGraceSeconds + 2) * 1000);
    expect(state().players).toHaveLength(1);
    expect(state().players[0].id).toBe(playerId);

    // The new socket really is bound to the old player: its input moves that poi.
    io.clear();
    room.handleInput(socket.id, encodeInput(input({ x: 0.9 })));
    vi.advanceTimersByTime(1500);
    const poi = latestPoi();
    expect(poi).toHaveLength(1);
    expect(poi[0].playerNumber).toBe(first.ack.playerNumber);
    expect(poi[0].x).toBeGreaterThan(4);
  });

  it('removes a disconnected player after the grace period and leaves the rest alone', () => {
    room.handleAdminCommand({ type: 'SETTINGS', settings: { fishCount: GAME.minFishCount } });
    const a = join('A');
    const b = join('B');

    room.detach(a.socket.id);
    vi.advanceTimersByTime(1000);
    expect(state().players).toHaveLength(2);

    vi.advanceTimersByTime((GAME.reconnectGraceSeconds + 1) * 1000);

    const players = state().players;
    expect(players).toHaveLength(1);
    expect(players[0].id).toBe(b.ack.playerId);
    expect(players[0].number).toBe(2);
    expect(players[0].connected).toBe(true);

    const left = payloadsOf<PlayerLeftPayload>(io, EV.EVENT_PLAYER_LEFT, ROOM_CHANNEL);
    expect(left.map((p) => p.playerId)).toEqual([a.ack.playerId]);
  });

  it('gives a screen the current room state and phase the moment it attaches', () => {
    const screen = attachScreen();

    expect(screen.rooms.has(ROOM_CHANNEL)).toBe(true);
    expect(screen.rooms.has(SCREEN_CHANNEL)).toBe(true);

    const rooms = payloadsOf<RoomPublicState>(io, EV.ROOM_STATE, screen.id);
    expect(rooms).toHaveLength(1);
    expect(rooms[0].id).toBe(ROOM);
    expect(rooms[0].state).toBe('WAITING');
    expect(rooms[0].screenConnected).toBe(true);

    const phases = payloadsOf<PhasePayload>(io, EV.PHASE, screen.id);
    expect(phases).toHaveLength(1);
    expect(phases[0].state).toBe('WAITING');
  });

  // -------------------------------------------------------------------------
  // phases
  // -------------------------------------------------------------------------

  it('walks WAITING -> CALIBRATION -> COUNTDOWN -> PLAYING -> RESULT -> WAITING', () => {
    room.handleAdminCommand({
      type: 'SETTINGS',
      settings: { fishCount: GAME.minFishCount, durationSeconds: GAME.minDurationSeconds },
    });
    const player = join('P');
    io.clear();

    expect(state().state).toBe('WAITING');

    room.handleAdminCommand({ type: 'START' });
    expect(state().state).toBe('CALIBRATION');
    // Spec §28: the phones are told to calibrate as the phase opens.
    expect(countOf(io, EV.CALIBRATE_REQUEST, player.socket.id)).toBe(1);

    vi.advanceTimersByTime(GAME.calibrationSeconds * 1000 + 100);
    expect(state().state).toBe('COUNTDOWN');

    vi.advanceTimersByTime(GAME.countdownSeconds * 1000 + 100);
    expect(state().state).toBe('PLAYING');
    expect(state().timeRemaining).toBeGreaterThan(GAME.minDurationSeconds - 2);

    vi.advanceTimersByTime(GAME.minDurationSeconds * 1000 + 100);
    expect(state().state).toBe('RESULT');

    vi.advanceTimersByTime(GAME.resultSeconds * 1000 + 100);
    expect(state().state).toBe('WAITING');

    const phases = payloadsOf<PhasePayload>(io, EV.PHASE, ROOM_CHANNEL);
    expect(phases.map((p) => p.state)).toEqual([
      'CALIBRATION',
      'COUNTDOWN',
      'PLAYING',
      'RESULT',
      'WAITING',
    ]);
    for (const p of phases) {
      expect(typeof p.startedAt).toBe('number');
      expect(p.timeRemaining).toBeGreaterThanOrEqual(0);
    }
    // Only WAITING is open-ended.
    expect(phases[phases.length - 1].endsAt).toBeNull();
    expect(phases[0].endsAt).not.toBeNull();
  });

  it('emits a well-formed game:result when RESULT opens', () => {
    room.handleAdminCommand({ type: 'SETTINGS', settings: { fishCount: GAME.minFishCount } });
    const a = join('A');
    const b = join('B');
    runToPlaying();
    io.clear();

    room.handleAdminCommand({ type: 'SKIP_TO_RESULT' });
    expect(state().state).toBe('RESULT');

    const results = payloadsOf<GameResult>(io, EV.RESULT, ROOM_CHANNEL);
    expect(results).toHaveLength(1);

    const result = results[0];
    expect(result.roomId).toBe(ROOM);
    expect(result.durationSeconds).toBe(GAME.defaultDurationSeconds);
    expect(typeof result.finishedAt).toBe('number');
    expect(Array.isArray(result.awards)).toBe(true);

    expect(result.rankings).toHaveLength(2);
    const ids = result.rankings.map((r) => r.id).sort();
    expect(ids).toEqual([a.ack.playerId, b.ack.playerId].sort());
    for (const r of result.rankings) {
      expect(r.rank).toBeGreaterThanOrEqual(1);
      expect(r.rank).toBeLessThanOrEqual(2);
      expect(typeof r.score).toBe('number');
      expect(r.spectating).toBe(false);
      expect(r.bestFish === null || typeof r.bestFish.score === 'number').toBe(true);
    }
    // Nobody scooped anything, so both share first place.
    expect(result.rankings.every((r) => r.rank === 1)).toBe(true);

    expect(state().result).not.toBeNull();
    expect(state().result?.rankings).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // input
  // -------------------------------------------------------------------------

  it('moves a poi in the direction of the input and broadcasts it to the screen', () => {
    room.handleAdminCommand({ type: 'SETTINGS', settings: { fishCount: GAME.minFishCount } });
    attachScreen();
    const player = join('P');
    io.clear();

    room.handleInput(player.socket.id, encodeInput(input({ x: 0.9 })));
    vi.advanceTimersByTime(2000);

    const right = latestPoi();
    expect(right).toHaveLength(1);
    expect(right[0].playerNumber).toBe(1);
    expect(right[0].x).toBeGreaterThan(POI_START_X[0]);
    expect(right[0].x).toBeGreaterThan(4);

    room.handleInput(player.socket.id, encodeInput(input({ x: -0.9 })));
    vi.advanceTimersByTime(2000);

    const left = latestPoi();
    expect(left[0].x).toBeLessThan(right[0].x);
    expect(left[0].x).toBeLessThan(-4);

    // Levelling the phone brings it back to the middle (absolute mapping, §133).
    room.handleInput(player.socket.id, encodeInput(input({ x: 0 })));
    vi.advanceTimersByTime(2000);
    expect(Math.abs(latestPoi()[0].x)).toBeLessThan(0.2);
  });

  it('sends no snapshots at all while no screen is connected', () => {
    room.handleAdminCommand({ type: 'SETTINGS', settings: { fishCount: GAME.minFishCount } });
    const player = join('P');
    room.handleInput(player.socket.id, encodeInput(input({ x: 0.5 })));
    vi.advanceTimersByTime(1000);

    expect(countOf(io, EV.SNAPSHOT_POI)).toBe(0);
    expect(countOf(io, EV.SNAPSHOT_FISH)).toBe(0);
    // The room itself keeps simulating, it just has nobody to send pixels to.
    expect(state().players[0].poiState).toBe('Above');
  });

  it('keeps the poi above the water outside PLAYING, and submerges it during it', () => {
    room.handleAdminCommand({ type: 'SETTINGS', settings: { fishCount: GAME.minFishCount } });
    const player = join('P');

    // Practice mode: tilt still moves the poi, but the scoop gesture is ignored.
    room.handleInput(player.socket.id, encodeInput(input({ isSubmerging: true, x: 0.3 })));
    vi.advanceTimersByTime(2500);
    expect(state().players[0].poiState).toBe('Above');
    expect(state().players[0].poiWetness).toBe(0);
    expect(state().players[0].poiDurability).toBe(POI.maxDurability);

    runToPlaying();

    room.handleInput(player.socket.id, encodeInput(input({ isSubmerging: true, x: 0.3 })));
    vi.advanceTimersByTime(1500);
    expect(state().players[0].poiState).toBe('Submerged');
    expect(state().players[0].poiWetness).toBeGreaterThan(0);
    expect(state().players[0].score).toBe(0);
  });

  it('ignores input from a socket that never joined', () => {
    room.handleAdminCommand({ type: 'SETTINGS', settings: { fishCount: GAME.minFishCount } });
    join('P');
    room.handleInput('nobody', encodeInput(input({ x: 1 })));
    // Garbage on a real socket is dropped rather than throwing.
    const player = join('Q');
    room.handleInput(player.socket.id, new ArrayBuffer(3));
    vi.advanceTimersByTime(500);
    expect(state().players).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // admin
  // -------------------------------------------------------------------------

  it('clamps out-of-range settings instead of accepting them', () => {
    room.handleAdminCommand({
      type: 'SETTINGS',
      settings: { durationSeconds: 5, fishCount: 0, maxPlayers: 0 },
    });
    let settings = state().settings;
    expect(settings.durationSeconds).toBe(GAME.minDurationSeconds);
    expect(settings.fishCount).toBe(GAME.minFishCount);
    expect(settings.maxPlayers).toBe(1);

    room.handleAdminCommand({
      type: 'SETTINGS',
      settings: { durationSeconds: 5000, fishCount: 9999, maxPlayers: 999 },
    });
    settings = state().settings;
    expect(settings.durationSeconds).toBe(GAME.maxDurationSeconds);
    expect(settings.fishCount).toBe(GAME.maxFishCount);
    expect(settings.maxPlayers).toBe(GAME.hardMaxPlayers);

    // Flags are passed through untouched.
    room.handleAdminCommand({
      type: 'SETTINGS',
      settings: { poiBreakPenalty: false, audioEnabled: false, highQuality: false },
    });
    settings = state().settings;
    expect(settings.poiBreakPenalty).toBe(false);
    expect(settings.audioEnabled).toBe(false);
    expect(settings.highQuality).toBe(false);
    expect(settings.durationSeconds).toBe(GAME.maxDurationSeconds);
  });

  it('adds and clears bots without counting them as real players', () => {
    room.handleAdminCommand({ type: 'ADD_BOT', count: 2 });

    let players = state().players;
    expect(players).toHaveLength(2);
    expect(players.map((p) => p.number)).toEqual([1, 2]);
    expect(players.map((p) => p.name)).toEqual(['BOT 1', 'BOT 2']);
    expect(players.every((p) => p.connected && p.controllerReady)).toBe(true);
    expect(room.playerCount).toBe(0);

    // A real phone takes the next free seat behind them.
    const human = join('H');
    expect(human.ack.playerNumber).toBe(3);
    expect(room.playerCount).toBe(1);

    room.handleAdminCommand({ type: 'CLEAR_BOTS' });
    players = state().players;
    expect(players).toHaveLength(1);
    expect(players[0].id).toBe(human.ack.playerId);
    expect(room.playerCount).toBe(1);
  });

  it('records controller readiness and calibration for the lobby', () => {
    const player = join('P');
    room.handleReady(player.socket.id, {
      controllerReady: true,
      status: { hasOrientation: true, hasMotion: true, gravityOnly: false },
    });
    expect(state().players[0].controllerReady).toBe(true);

    room.handleCalibrated(player.socket.id);
    expect(state().players[0].calibrated).toBe(true);
  });

  // -------------------------------------------------------------------------
  // the phone's private bowl
  // -------------------------------------------------------------------------

  it('pushes a bowl:state to each player socket with their own fish', () => {
    room.handleAdminCommand({ type: 'SETTINGS', settings: { fishCount: GAME.minFishCount } });
    const a = join('A');
    const b = join('B');
    vi.advanceTimersByTime(200);

    const bowl = lastPayloadOf<BowlStatePayload>(io, EV.BOWL_STATE, a.socket.id);
    expect(bowl).toBeDefined();
    const payload = bowl!;
    expect(payload.playerId).toBe(a.ack.playerId);
    expect(payload.playerNumber).toBe(1);
    expect(Array.isArray(payload.capturedFish)).toBe(true);
    expect(payload.capturedFish).toEqual([]);
    expect(payload.score).toBe(0);
    expect(payload.poiDurability).toBe(POI.maxDurability);
    expect(payload.poiState).toBe('Above');
    expect(payload.respawnIn).toBe(0);
    expect(payload.connected).toBe(true);

    // Each phone is addressed privately, never through the room channel.
    const other = lastPayloadOf<BowlStatePayload>(io, EV.BOWL_STATE, b.socket.id);
    expect(other?.playerId).toBe(b.ack.playerId);
    expect(countOf(io, EV.BOWL_STATE, ROOM_CHANNEL)).toBe(0);
  });

  it('stops ticking once disposed', () => {
    room.handleAdminCommand({ type: 'SETTINGS', settings: { fishCount: GAME.minFishCount } });
    attachScreen();
    join('P');
    vi.advanceTimersByTime(500);
    const before = countOf(io, EV.SNAPSHOT_POI, SCREEN_CHANNEL);
    expect(before).toBeGreaterThan(0);

    room.dispose();
    vi.advanceTimersByTime(1000);
    expect(countOf(io, EV.SNAPSHOT_POI, SCREEN_CHANNEL)).toBe(before);
  });
})

describe('phantom seats (venue regression)', () => {
  let io: FakeIo;
  let room: GameRoom;

  beforeEach(() => {
    // 'performance' matters: the idle sweep measures silence with
    // performance.now(), so a clock that only fakes Date would never advance it.
    installFakeClock();
    io = new FakeIo();
    room = new GameRoom('GHOST', io.asServer);
  });

  afterEach(() => {
    room.dispose();
    vi.useRealTimers();
  });

  it('CLEAR_PLAYERS empties a room whose players are unreachable', () => {
    const a = io.connect();
    const b = io.connect();
    expect(room.join(a.asSocket, { roomId: 'GHOST' }).ok).toBe(true);
    expect(room.join(b.asSocket, { roomId: 'GHOST' }).ok).toBe(true);
    expect(room.playerCount).toBe(2);

    room.handleAdminCommand({ type: 'CLEAR_PLAYERS' });
    expect(room.playerCount).toBe(0);
    // The seats are genuinely free again, not merely hidden.
    expect(room.join(io.connect().asSocket, { roomId: 'GHOST' }).playerNumber).toBe(1);
  });

  it('a seat that never streams input cannot start rounds by itself', () => {
    const s = io.connect();
    expect(room.join(s.asSocket, { roomId: 'GHOST' }).ok).toBe(true);
    // The phone claimed to be ready and then went quiet — the exact shape of a
    // browser tab left open on a desk.
    room.handleReady(s.id, { controllerReady: true });

    // Auto-start would otherwise fire a few seconds in, and keep firing, which
    // is what stopped the lobby from ever settling into WAITING.
    vi.advanceTimersByTime(20_000);
    expect(room.publicState().state).toBe('WAITING');
  });

  it('sweeps a seat whose page stopped sending input, but not too eagerly', () => {
    const s = io.connect();
    expect(room.join(s.asSocket, { roomId: 'GHOST' }).ok).toBe(true);
    expect(room.playerCount).toBe(1);

    // A briefly backgrounded phone stops its animation frame loop, and therefore
    // its input, for a few seconds. It must keep its seat.
    vi.advanceTimersByTime(20_000);
    expect(room.playerCount).toBe(1);

    // Silence far past any plausible hiccup: the tab is gone.
    vi.advanceTimersByTime(60_000);
    expect(room.playerCount).toBe(0);
  });
});
