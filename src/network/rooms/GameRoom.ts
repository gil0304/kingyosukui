/**
 * One giant screen = one room (spec §41).
 *
 * The room owns the authoritative simulation: poi physics, fish AI, capture
 * arbitration, scoring and the phase machine. Clients only ever send input and
 * render what the server tells them (spec §83).
 *
 * Server-only module: it imports socket.io. Everything it simulates comes from
 * [PURE] modules that also run in the browser during tests.
 */

import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';

import { GAME, PLAYER_COLORS, POI, POI_START_X, TANK } from '@/game/core/constants';
import { clamp, createRng, nowSeconds, type Rng } from '@/game/core/math';
import { FishSimulation, type PoiQuery } from '@/game/fish/fishSimulation';
import { getFishData } from '@/game/fish/fishTypes';
import { CaptureSystem, type CaptureActor, type DropReason } from '@/game/poi/captureSystem';
import { PoiSimulation, type PoiInput } from '@/game/poi/poiSimulation';
import { RoomLifecycle } from '@/game/lifecycle/roomLifecycle';
import { buildResult, type ScoringInput } from '@/game/scoring/scoring';
import {
  encodeFishPacket,
  encodePoiPacket,
  decodeInput,
  type PoiWire,
} from '@/network/protocol/codec';
import {
  EV,
  type AdminCommand,
  type BowlStatePayload,
  type PlayerJoinAck,
  type PlayerJoinPayload,
  type PlayerReadyPayload,
  type PhasePayload,
} from '@/network/protocol/events';
import {
  wetnessStage,
  type CapturedFish,
  type GameResult,
  type PlayerPublicState,
  type RoomPublicState,
  type RoomSettings,
  type RoomState,
} from '@/types';

interface PlayerRecord {
  id: string;
  number: number;
  name: string;
  color: string;
  socketId: string | null;

  connected: boolean;
  controllerReady: boolean;
  calibrated: boolean;
  spectating: boolean;

  score: number;
  capturedFish: CapturedFish[];
  poiBreaks: number;

  poi: PoiSimulation;
  input: PoiInput;
  resumeToken: string;

  joinedAt: number;
  disconnectedAt: number | null;
  lastInputAt: number;
  /** True once a real controller packet has arrived — not merely a claim of readiness. */
  hasSentInput: boolean;
  /** Epoch ms the paper last tore, so the phone can show a real countdown. */
  brokenAt: number | null;
  /** Synthetic player used to rehearse a 4-player round without 4 phones. */
  bot: BotState | null;

  sensor: { hasOrientation: boolean; hasMotion: boolean; gravityOnly: boolean };
  bowlDirty: boolean;
}

interface BotState {
  seed: number;
  phase: number;
  diveAt: number;
  liftAt: number;
}

const emptyInput = (): PoiInput => ({
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
  connected: true,
});

const DEFAULT_SETTINGS: RoomSettings = {
  durationSeconds: GAME.defaultDurationSeconds,
  fishCount: GAME.defaultFishCount,
  maxPlayers: GAME.maxPlayers,
  poiBreakPenalty: true,
  audioEnabled: true,
  highQuality: true,
};

/** Seconds of a stable, ready lobby before a round starts by itself (spec §98). */
const AUTO_START_DELAY = 4.0;
/**
 * A connected player that has sent no input for this long, while the room is
 * merely waiting, is treated as gone. Generous on purpose: a phone that briefly
 * backgrounds stops its animation frame loop and therefore its input.
 */
const IDLE_SEAT_SECONDS = 45;
/**
 * How recently a seat must have sent input to count as a real, present player
 * for the purpose of starting a round.
 */
const LIVE_INPUT_SECONDS = 6;

export class GameRoom {
  readonly id: string;
  private readonly io: Server;

  private readonly players = new Map<string, PlayerRecord>(); // by playerId
  private readonly bySocket = new Map<string, string>(); // socketId -> playerId
  private readonly screens = new Set<string>();
  private readonly admins = new Set<string>();

  private settings: RoomSettings = { ...DEFAULT_SETTINGS };
  private readonly lifecycle: RoomLifecycle;
  private readonly fish: FishSimulation;
  private readonly capture: CaptureSystem;
  private rng: Rng;

  private timer: NodeJS.Timeout | null = null;
  private lastTick = 0;
  private tick = 0;
  private epochMs = Date.now();
  private simTime = 0;

  private fishAccum = 0;
  private poiAccum = 0;
  private stateAccum = 0;
  private bowlAccum = 0;
  private readyStableFor = 0;

  private result: GameResult | null = null;
  private roomDirty = true;
  private lastActivityAt = Date.now();

  private readonly actors: CaptureActor[] = [];
  private readonly poiQueries: PoiQuery[] = [];
  private readonly poiWire: PoiWire[] = [];

  constructor(id: string, io: Server) {
    this.id = id;
    this.io = io;
    this.rng = createRng(hashString(id));
    this.fish = new FishSimulation(this.settings.fishCount, this.rng.int(1, 1 << 30));
    this.capture = new CaptureSystem(this.fish, this.rng.int(1, 1 << 30));
    this.capture.setEnabled(false);

    this.lifecycle = new RoomLifecycle({
      onEnter: (s) => this.onEnterPhase(s),
      onExit: (s) => this.onExitPhase(s),
    });
    this.lifecycle.setPlayingDuration(this.settings.durationSeconds);

    this.lastTick = nowSeconds();
    this.timer = setInterval(() => this.step(), 1000 / GAME.tickHz);
    // The tick loop must never keep the process alive on its own.
    this.timer.unref?.();
  }

  // -------------------------------------------------------------------------
  // membership
  // -------------------------------------------------------------------------

  get playerCount(): number {
    return [...this.players.values()].filter((p) => !p.bot).length;
  }

  get isEmpty(): boolean {
    return this.players.size === 0 && this.screens.size === 0 && this.admins.size === 0;
  }

  get lastActivity(): number {
    return this.lastActivityAt;
  }

  private touch(): void {
    this.lastActivityAt = Date.now();
  }

  attachScreen(socket: Socket): void {
    this.screens.add(socket.id);
    socket.join(this.roomChannel);
    socket.join(this.screenChannel);
    this.touch();
    this.roomDirty = true;
    socket.emit(EV.ROOM_STATE, this.publicState());
    socket.emit(EV.PHASE, this.phasePayload());
  }

  attachAdmin(socket: Socket): void {
    this.admins.add(socket.id);
    socket.join(this.roomChannel);
    this.touch();
    socket.emit(EV.ROOM_STATE, this.publicState());
  }

  join(socket: Socket, payload: PlayerJoinPayload): PlayerJoinAck {
    this.touch();

    // Reconnect path: a reloaded phone reclaims its seat (spec §84).
    if (payload.resumeToken) {
      for (const p of this.players.values()) {
        if (p.resumeToken === payload.resumeToken) {
          if (p.socketId && p.socketId !== socket.id) this.bySocket.delete(p.socketId);
          p.socketId = socket.id;
          p.connected = true;
          p.disconnectedAt = null;
          p.input.connected = true;
          this.bySocket.set(socket.id, p.id);
          socket.join(this.roomChannel);
          this.roomDirty = true;
          p.bowlDirty = true;
          return {
            ok: true,
            playerId: p.id,
            playerNumber: p.number,
            color: p.color,
            resumeToken: p.resumeToken,
            spectating: p.spectating,
            room: this.publicState(),
          };
        }
      }
    }

    const seat = this.freeSeat();
    if (seat === null) return { ok: false, reason: 'ROOM_FULL' };

    // Spec §85: joining mid-round means waiting for the next one.
    const spectating = this.lifecycle.state !== 'WAITING' && this.lifecycle.state !== 'RESULT';

    const id = randomUUID();
    const color = PLAYER_COLORS[(seat - 1) % PLAYER_COLORS.length]!;
    const record: PlayerRecord = {
      id,
      number: seat,
      name: payload.name?.slice(0, 12) || `PLAYER ${seat}`,
      color,
      socketId: socket.id,
      connected: true,
      controllerReady: false,
      calibrated: false,
      spectating,
      score: 0,
      capturedFish: [],
      poiBreaks: 0,
      poi: new PoiSimulation(seat, startXFor(seat)),
      input: emptyInput(),
      resumeToken: randomUUID(),
      joinedAt: Date.now(),
      disconnectedAt: null,
      lastInputAt: nowSeconds(),
      hasSentInput: false,
      brokenAt: null,
      bot: null,
      sensor: { hasOrientation: false, hasMotion: false, gravityOnly: false },
      bowlDirty: true,
    };

    this.players.set(id, record);
    this.bySocket.set(socket.id, id);
    socket.join(this.roomChannel);
    this.roomDirty = true;

    // Spec §47: announce the new poi entering the tank.
    this.io.to(this.roomChannel).emit(EV.EVENT_PLAYER_JOINED, {
      playerId: id,
      playerNumber: seat,
      name: record.name,
      color,
    });

    return {
      ok: true,
      playerId: id,
      playerNumber: seat,
      color,
      resumeToken: record.resumeToken,
      spectating,
      room: this.publicState(),
    };
  }

  handleReady(socketId: string, p: PlayerReadyPayload): void {
    const rec = this.bySocketRecord(socketId);
    if (!rec) return;
    rec.controllerReady = p.controllerReady;
    if (p.status) rec.sensor = { ...p.status };
    this.roomDirty = true;
    this.touch();
  }

  handleCalibrated(socketId: string): void {
    const rec = this.bySocketRecord(socketId);
    if (!rec) return;
    rec.calibrated = true;
    this.roomDirty = true;
  }

  handleInput(socketId: string, buf: ArrayBuffer | Buffer | Uint8Array): void {
    const rec = this.bySocketRecord(socketId);
    if (!rec) return;
    const wire = decodeInput(buf);
    if (!wire) return;

    const i = rec.input;
    i.x = clamp(wire.x, -1, 1);
    i.y = clamp(wire.y, -1, 1);
    i.tiltX = wire.tiltX;
    i.tiltY = wire.tiltY;
    i.tiltZ = wire.tiltZ;
    i.verticalAcceleration = wire.verticalAcceleration;
    i.handOffsetY = wire.handOffsetY;
    i.handVelocityY = wire.handVelocityY;
    i.liftPeakAccel = wire.liftPeakAccel;
    // Practice mode: outside PLAYING the poi hovers so nobody scores by accident,
    // but tilt still moves it — new players learn the control before the round.
    const playing = this.lifecycle.state === 'PLAYING' && !rec.spectating;
    i.isSubmerging = playing && wire.isSubmerging;
    i.isLifting = playing && wire.isLifting;
    i.connected = true;

    rec.lastInputAt = nowSeconds();
    rec.hasSentInput = true;
    rec.connected = true;
    this.touch();
  }

  handleAdminCommand(cmd: AdminCommand): void {
    this.touch();
    switch (cmd.type) {
      case 'START':
        if (this.lifecycle.state === 'WAITING' || this.lifecycle.state === 'RESULT') {
          this.lifecycle.to('CALIBRATION', Date.now(), GAME.calibrationSeconds);
        }
        break;
      case 'RESET':
        this.lifecycle.to('WAITING', Date.now());
        break;
      case 'SKIP_TO_RESULT':
        if (this.lifecycle.state === 'PLAYING') {
          this.lifecycle.to('RESULT', Date.now(), GAME.resultSeconds);
        }
        break;
      case 'SETTINGS': {
        const s = cmd.settings;
        if (typeof s.durationSeconds === 'number') {
          this.settings.durationSeconds = clamp(
            Math.round(s.durationSeconds),
            GAME.minDurationSeconds,
            GAME.maxDurationSeconds,
          );
          this.lifecycle.setPlayingDuration(this.settings.durationSeconds);
        }
        if (typeof s.fishCount === 'number') {
          this.settings.fishCount = clamp(
            Math.round(s.fishCount),
            GAME.minFishCount,
            GAME.maxFishCount,
          );
          if (this.lifecycle.state === 'WAITING') {
            this.fish.reset(this.settings.fishCount, this.rng.int(1, 1 << 30));
          }
        }
        if (typeof s.maxPlayers === 'number') {
          this.settings.maxPlayers = clamp(Math.round(s.maxPlayers), 1, GAME.hardMaxPlayers);
        }
        if (typeof s.poiBreakPenalty === 'boolean') this.settings.poiBreakPenalty = s.poiBreakPenalty;
        if (typeof s.audioEnabled === 'boolean') this.settings.audioEnabled = s.audioEnabled;
        if (typeof s.highQuality === 'boolean') this.settings.highQuality = s.highQuality;
        this.roomDirty = true;
        break;
      }
      case 'KICK': {
        const rec = this.players.get(cmd.playerId);
        if (rec) this.removePlayer(rec);
        break;
      }
      case 'ADD_BOT':
        for (let i = 0; i < (cmd.count ?? 1); i++) this.addBot();
        break;
      case 'CLEAR_BOTS':
        for (const p of [...this.players.values()]) if (p.bot) this.removePlayer(p);
        break;
      case 'CLEAR_PLAYERS':
        // The operator's escape hatch for a seat held by a browser tab nobody
        // can find any more. Also ends the round: continuing with no players
        // would just run the clock down in front of an empty tank.
        for (const p of [...this.players.values()]) this.removePlayer(p);
        if (this.lifecycle.state !== 'WAITING') this.lifecycle.to('WAITING', Date.now());
        break;
    }
    this.roomDirty = true;
  }

  detach(socketId: string): void {
    if (this.screens.delete(socketId)) this.roomDirty = true;
    if (this.admins.delete(socketId)) this.roomDirty = true;

    const rec = this.bySocketRecord(socketId);
    if (!rec) return;
    this.bySocket.delete(socketId);
    rec.socketId = null;
    rec.connected = false;
    rec.disconnectedAt = Date.now();
    rec.input.connected = false;
    // Spec §84: their poi stops, everyone else keeps playing.
    rec.poi.setDisconnected();
    this.roomDirty = true;
    this.touch();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // -------------------------------------------------------------------------
  // simulation
  // -------------------------------------------------------------------------

  private step(): void {
    const now = nowSeconds();
    let dt = now - this.lastTick;
    this.lastTick = now;
    // A stalled event loop must not teleport the world.
    if (!Number.isFinite(dt) || dt <= 0) return;
    dt = Math.min(dt, 0.1);
    this.simTime += dt;
    this.tick++;

    const nowMs = Date.now();
    this.lifecycle.tick(nowMs);
    this.reapDisconnected(nowMs);
    this.maybeAutoStart(dt);

    // --- poi ---------------------------------------------------------------
    this.actors.length = 0;
    this.poiQueries.length = 0;

    const list = [...this.players.values()].sort((a, b) => a.number - b.number);
    for (const p of list) {
      if (p.bot) this.driveBot(p, dt);
      p.poi.setInput(p.input);
      const events = p.poi.update(dt, this.simTime);

      let liftResolved = false;
      let broke = false;
      for (const e of events) {
        switch (e.type) {
          case 'ENTER_WATER':
            this.emitSplash('ENTER', p.poi.x, p.poi.z, clamp(e.strength, 0.25, 1), p.number);
            break;
          case 'EXIT_WATER':
            this.emitSplash('EXIT', p.poi.x, p.poi.z, clamp(e.strength, 0.25, 1), p.number);
            break;
          case 'LIFT_RESOLVED':
            liftResolved = true;
            break;
          case 'BROKE':
            broke = true;
            break;
          case 'RESPAWNED':
            p.brokenAt = null;
            this.io.to(this.roomChannel).emit(EV.EVENT_POI_RESPAWN, {
              playerId: p.id,
              playerNumber: p.number,
            });
            p.bowlDirty = true;
            break;
        }
      }
      this.actors.push({ playerNumber: p.number, poi: p.poi, liftResolved, broke });
    }

    // Poi never overlap, but they never fight either (spec §49).
    for (let i = 0; i < this.actors.length; i++) {
      for (let j = i + 1; j < this.actors.length; j++) {
        if (PoiSimulation.separate(this.actors[i]!.poi, this.actors[j]!.poi, dt)) {
          const a = this.actors[i]!.poi;
          const b = this.actors[j]!.poi;
          if (a.inWater || b.inWater) {
            this.emitSplash('POI_COLLIDE', (a.x + b.x) / 2, (a.z + b.z) / 2, 0.3, 0);
          }
        }
      }
    }

    // --- fish --------------------------------------------------------------
    for (const p of list) {
      const poi = p.poi;
      this.poiQueries.push({
        playerNumber: p.number,
        x: poi.x,
        y: poi.y,
        z: poi.z,
        radius: POI.frameRadius,
        inWater: poi.inWater,
        active: poi.active,
        speed: poi.speed,
      });
    }
    this.fish.update(dt, this.poiQueries);

    // --- capture -----------------------------------------------------------
    this.capture.update(dt, this.simTime, this.actors, {
      onCapture: (pn, fishId, fishType, score, at, capturedAt) => {
        const rec = this.byNumber(pn);
        if (!rec) return;
        const cf: CapturedFish = {
          id: `${fishId}-${Math.round(capturedAt * 1000)}`,
          fishType,
          score,
          capturedAt: Date.now(),
        };
        rec.capturedFish.push(cf);
        rec.score += score;
        rec.bowlDirty = true;
        this.roomDirty = true;
        const data = getFishData(fishType);
        this.io.to(this.roomChannel).emit(EV.EVENT_CAPTURE, {
          playerId: rec.id,
          playerNumber: pn,
          fishId,
          fishType,
          fishLabel: data.label,
          rarity: data.rarity,
          score,
          totalScore: rec.score,
          fishCount: rec.capturedFish.length,
          x: at.x,
          y: at.y,
          z: at.z,
          capturedFish: cf,
          serverTime: Date.now(),
        });
        this.emitSplash('CAPTURE', at.x, at.z, 0.85, pn);
      },
      onDrop: (pn, fishId, fishType, reason, at) => {
        const rec = this.byNumber(pn);
        if (!rec) return;
        this.io.to(this.roomChannel).emit(EV.EVENT_DROP, {
          playerId: rec.id,
          playerNumber: pn,
          fishId,
          fishType,
          reason: reason === 'ESCAPE' ? 'TILT' : reason,
          x: at.x,
          y: at.y,
          z: at.z,
        });
        this.emitSplash('FISH_SURFACE', at.x, at.z, 0.35, pn);
      },
      onContact: () => {
        /* contact is silent; the tension comes from the visuals */
      },
    });

    // --- poi breakage bookkeeping -----------------------------------------
    for (let i = 0; i < this.actors.length; i++) {
      const a = this.actors[i]!;
      if (!a.broke) continue;
      const rec = this.byNumber(a.playerNumber);
      if (!rec) continue;
      rec.poiBreaks++;
      rec.brokenAt = Date.now();
      const penalty =
        this.settings.poiBreakPenalty && this.lifecycle.state === 'PLAYING' ? POI.breakPenalty : 0;
      rec.score = Math.max(0, rec.score - penalty);
      rec.bowlDirty = true;
      this.roomDirty = true;
      this.io.to(this.roomChannel).emit(EV.EVENT_POI_BREAK, {
        playerId: rec.id,
        playerNumber: rec.number,
        x: a.poi.x,
        y: a.poi.y,
        z: a.poi.z,
        droppedFish: 0,
        penalty,
        respawnInSeconds: POI.respawnSeconds,
      });
      this.emitSplash('BREAK', a.poi.x, a.poi.z, 0.7, rec.number);
    }

    // --- rare spawns (a glint, never a banner — spec §108) ------------------
    const rares = this.fish.drainRareSpawns();
    for (const r of rares) {
      this.io.to(this.screenChannel).emit(EV.EVENT_RARE_SPAWN, {
        fishId: r.id,
        fishType: r.type,
        x: r.x,
        y: r.y,
        z: r.z,
      });
    }

    this.broadcast(dt, nowMs);
  }

  private broadcast(dt: number, nowMs: number): void {
    const timeMs = nowMs - this.epochMs;

    this.poiAccum += dt;
    if (this.poiAccum >= 1 / GAME.poiSnapshotHz && this.screens.size > 0) {
      this.poiAccum = 0;
      this.poiWire.length = 0;
      for (const p of this.players.values()) {
        if (p.spectating) continue;
        this.poiWire.push(p.poi.toWire());
      }
      this.io
        .to(this.screenChannel)
        .emit(EV.SNAPSHOT_POI, encodePoiPacket(this.tick, timeMs, this.poiWire));
    }

    this.fishAccum += dt;
    if (this.fishAccum >= 1 / GAME.fishSnapshotHz && this.screens.size > 0) {
      this.fishAccum = 0;
      this.io
        .to(this.screenChannel)
        .emit(EV.SNAPSHOT_FISH, encodeFishPacket(this.tick, timeMs, this.fish.getWire()));
    }

    this.stateAccum += dt;
    if (this.roomDirty || this.stateAccum >= 1) {
      this.stateAccum = 0;
      this.roomDirty = false;
      this.io.to(this.roomChannel).emit(EV.ROOM_STATE, this.publicState());
    }

    this.bowlAccum += dt;
    const bowlHeartbeat = this.bowlAccum >= 0.5;
    if (bowlHeartbeat) this.bowlAccum = 0;
    for (const p of this.players.values()) {
      if (!p.socketId) continue;
      if (!p.bowlDirty && !bowlHeartbeat) continue;
      p.bowlDirty = false;
      this.io.to(p.socketId).emit(EV.BOWL_STATE, this.bowlState(p));
    }
  }

  // -------------------------------------------------------------------------
  // phases
  // -------------------------------------------------------------------------

  private maybeAutoStart(dt: number): void {
    if (this.lifecycle.state !== 'WAITING') {
      this.readyStableFor = 0;
      return;
    }
    // 'controllerReady' is a claim the phone made once. Whether a controller is
    // actually THERE is a different question, and the one that matters: a seat
    // held by a socket whose page has stopped streaming input would otherwise
    // start round after round in front of an empty room, and keep the lobby out
    // of WAITING long enough that the idle sweep never gets a look at it.
    const now = nowSeconds();
    const ready = [...this.players.values()].filter(
      (p) =>
        p.connected &&
        p.controllerReady &&
        !p.spectating &&
        p.hasSentInput &&
        (p.bot || now - p.lastInputAt < LIVE_INPUT_SECONDS),
    );
    if (ready.length === 0) {
      this.readyStableFor = 0;
      return;
    }
    this.readyStableFor += dt;
    if (this.readyStableFor >= AUTO_START_DELAY) {
      this.readyStableFor = 0;
      this.lifecycle.to('CALIBRATION', Date.now(), GAME.calibrationSeconds);
    }
  }

  private onEnterPhase(s: RoomState): void {
    const nowMs = Date.now();
    this.roomDirty = true;

    switch (s) {
      case 'WAITING':
        this.capture.setEnabled(false);
        this.fish.setCalmMode(false);
        // Everyone who was waiting for the next round is now in it (spec §85).
        for (const p of this.players.values()) {
          p.spectating = false;
          p.calibrated = false;
          p.bowlDirty = true;
        }
        break;

      case 'CALIBRATION': {
        this.result = null;
        this.capture.setEnabled(false);
        this.fish.setCalmMode(false);
        this.resetRound();
        // Spec §28/§29: the phones calibrate automatically while the screen counts down.
        for (const p of this.players.values()) {
          p.calibrated = false;
          if (p.socketId) {
            this.io
              .to(p.socketId)
              .emit(EV.CALIBRATE_REQUEST, { durationSeconds: GAME.calibrationSeconds });
          }
        }
        break;
      }

      case 'COUNTDOWN':
        this.capture.setEnabled(false);
        break;

      case 'PLAYING':
        this.capture.setEnabled(true);
        break;

      case 'RESULT': {
        this.capture.setEnabled(false);
        // Spec §102: poi rise out of the water, the fish calm down.
        this.capture.releaseAll(this.actors, 'TIMEUP', {
          onCapture: () => {},
          onDrop: () => {},
          onContact: () => {},
        });
        for (const p of this.players.values()) p.poi.parkForTimeUp();
        this.fish.setCalmMode(true);
        this.result = buildResult(
          this.id,
          this.scoringInputs(),
          this.settings.durationSeconds,
          nowMs,
        );
        this.io.to(this.roomChannel).emit(EV.RESULT, this.result);
        for (const p of this.players.values()) p.bowlDirty = true;
        break;
      }
    }

    this.io.to(this.roomChannel).emit(EV.PHASE, this.phasePayload());
  }

  private onExitPhase(_s: RoomState): void {
    /* transitions are handled on entry; kept for symmetry and future hooks */
  }

  private resetRound(): void {
    const seed = this.rng.int(1, 1 << 30);
    this.fish.reset(this.settings.fishCount, seed);
    this.capture.reset(seed ^ 0x9e3779b9);
    for (const p of this.players.values()) {
      p.score = 0;
      p.capturedFish = [];
      p.poiBreaks = 0;
      p.poi.reset(startXFor(p.number));
      p.bowlDirty = true;
    }
  }

  private reapDisconnected(nowMs: number): void {
    const now = nowSeconds();
    for (const p of [...this.players.values()]) {
      if (p.bot) continue;

      if (!p.connected && p.disconnectedAt !== null) {
        if (nowMs - p.disconnectedAt > GAME.reconnectGraceSeconds * 1000) {
          this.removePlayer(p);
        }
        continue;
      }

      // A socket can stay open long after the page behind it stopped existing —
      // a backgrounded tab, a phone asleep in a pocket, a laptop lid closed on a
      // test window. Such a seat is invisible to everyone but occupies a place a
      // real player wants. A live phone streams input at 60 Hz continuously, so
      // three quarters of a minute of total silence means nobody is holding it.
      // Rejoining takes one tap, so the cost of being wrong is tiny.
      if (p.connected && now - p.lastInputAt > IDLE_SEAT_SECONDS) {
        this.removePlayer(p);
      }
    }
  }

  private removePlayer(rec: PlayerRecord): void {
    // Anything on their paper falls back into the tank rather than vanishing.
    const actor: CaptureActor = {
      playerNumber: rec.number,
      poi: rec.poi,
      liftResolved: false,
      broke: false,
    };
    this.capture.releaseAll([actor], 'TIMEUP', {
      onCapture: () => {},
      onDrop: () => {},
      onContact: () => {},
    });
    this.players.delete(rec.id);
    if (rec.socketId) this.bySocket.delete(rec.socketId);
    this.io.to(this.roomChannel).emit(EV.EVENT_PLAYER_LEFT, {
      playerId: rec.id,
      playerNumber: rec.number,
    });
    this.roomDirty = true;
  }

  // -------------------------------------------------------------------------
  // bots (operations aid: rehearse a 4-player round with one phone)
  // -------------------------------------------------------------------------

  private addBot(): void {
    const seat = this.freeSeat();
    if (seat === null) return;
    const id = randomUUID();
    const color = PLAYER_COLORS[(seat - 1) % PLAYER_COLORS.length]!;
    this.players.set(id, {
      id,
      number: seat,
      name: `BOT ${seat}`,
      color,
      socketId: null,
      connected: true,
      controllerReady: true,
      calibrated: true,
      spectating: this.lifecycle.state !== 'WAITING' && this.lifecycle.state !== 'RESULT',
      score: 0,
      capturedFish: [],
      poiBreaks: 0,
      poi: new PoiSimulation(seat, startXFor(seat)),
      input: emptyInput(),
      resumeToken: randomUUID(),
      joinedAt: Date.now(),
      disconnectedAt: null,
      lastInputAt: nowSeconds(),
      hasSentInput: true,
      brokenAt: null,
      bot: {
        seed: this.rng.next() * 1000,
        phase: this.rng.next() * 100,
        diveAt: this.simTime + this.rng.range(1, 3),
        liftAt: Number.POSITIVE_INFINITY,
      },
      sensor: { hasOrientation: true, hasMotion: true, gravityOnly: false },
      bowlDirty: true,
    });
    this.roomDirty = true;
  }

  private driveBot(p: PlayerRecord, dt: number): void {
    const b = p.bot!;
    b.phase += dt;
    const t = b.phase;
    const i = p.input;
    i.x = Math.sin(t * 0.53 + b.seed) * 0.8;
    i.y = Math.sin(t * 0.37 + b.seed * 1.7) * 0.75;
    i.tiltX = i.x * 0.35;
    i.tiltY = i.y * 0.35;
    i.tiltZ = Math.sin(t * 0.21) * 0.15;
    i.connected = true;

    const playing = this.lifecycle.state === 'PLAYING' && !p.spectating;
    if (!playing) {
      i.isSubmerging = false;
      i.isLifting = false;
      return;
    }

    if (this.simTime > b.diveAt && !i.isSubmerging && !i.isLifting) {
      i.isSubmerging = true;
      b.liftAt = this.simTime + 1.6 + Math.abs(Math.sin(b.seed)) * 2.2;
    }
    if (this.simTime > b.liftAt) {
      i.isSubmerging = false;
      i.isLifting = true;
      i.handVelocityY = 0.5;
      i.verticalAcceleration = 4.2;
      i.liftPeakAccel = 4.2;
      if (p.poi.state === 'Above' || p.poi.state === 'Raised') {
        i.isLifting = false;
        i.handVelocityY = 0;
        i.liftPeakAccel = 0;
        b.diveAt = this.simTime + 1.2 + Math.abs(Math.cos(b.seed)) * 2.0;
        b.liftAt = Number.POSITIVE_INFINITY;
      }
    }
  }

  // -------------------------------------------------------------------------
  // serialisation
  // -------------------------------------------------------------------------

  private get roomChannel(): string {
    return `room:${this.id}`;
  }
  private get screenChannel(): string {
    return `screen:${this.id}`;
  }

  private bySocketRecord(socketId: string): PlayerRecord | undefined {
    const id = this.bySocket.get(socketId);
    return id ? this.players.get(id) : undefined;
  }

  private byNumber(n: number): PlayerRecord | undefined {
    for (const p of this.players.values()) if (p.number === n) return p;
    return undefined;
  }

  private freeSeat(): number | null {
    const taken = new Set([...this.players.values()].map((p) => p.number));
    for (let n = 1; n <= this.settings.maxPlayers; n++) {
      if (!taken.has(n)) return n;
    }
    return null;
  }

  private publicPlayer(p: PlayerRecord): PlayerPublicState {
    return {
      id: p.id,
      number: p.number,
      name: p.name,
      color: p.color,
      connected: p.connected,
      controllerReady: p.controllerReady,
      calibrated: p.calibrated,
      spectating: p.spectating,
      score: p.score,
      fishCount: p.capturedFish.length,
      poiDurability: p.poi.durability,
      poiWetness: p.poi.wetness,
      poiStage: wetnessStage(p.poi.wetness),
      poiState: p.poi.state,
      poiBreaks: p.poiBreaks,
    };
  }

  private scoringInputs(): ScoringInput[] {
    return [...this.players.values()].map((p) => ({
      ...this.publicPlayer(p),
      capturedFish: p.capturedFish,
    }));
  }

  publicState(): RoomPublicState {
    const nowMs = Date.now();
    return {
      id: this.id,
      state: this.lifecycle.state,
      players: [...this.players.values()]
        .sort((a, b) => a.number - b.number)
        .map((p) => this.publicPlayer(p)),
      settings: { ...this.settings },
      phaseStartedAt: this.lifecycle.startedAt,
      phaseEndsAt: this.lifecycle.endsAt,
      timeRemaining: this.lifecycle.timeRemaining(nowMs),
      result: this.result,
      waitingPlayers: [...this.players.values()].filter((p) => p.spectating).map((p) => p.id),
      serverTime: nowMs,
      screenConnected: this.screens.size > 0,
    };
  }

  private phasePayload(): PhasePayload {
    const nowMs = Date.now();
    const p = this.lifecycle.phase(nowMs);
    return {
      state: p.state,
      startedAt: p.startedAt,
      endsAt: p.endsAt,
      timeRemaining: this.lifecycle.timeRemaining(nowMs),
      count: this.lifecycle.countdown(nowMs),
    };
  }

  private bowlState(p: PlayerRecord): BowlStatePayload {
    const respawnIn =
      p.brokenAt === null
        ? 0
        : Math.max(0, POI.respawnSeconds - (Date.now() - p.brokenAt) / 1000);
    return {
      playerId: p.id,
      playerNumber: p.number,
      score: p.score,
      capturedFish: p.capturedFish,
      poiDurability: p.poi.durability,
      poiWetness: p.poi.wetness,
      poiState: p.poi.state,
      respawnIn,
      connected: p.connected,
    };
  }

  private emitSplash(
    kind: 'ENTER' | 'EXIT' | 'FISH_SURFACE' | 'CAPTURE' | 'POI_COLLIDE' | 'BREAK',
    x: number,
    z: number,
    strength: number,
    playerNumber: number,
  ): void {
    if (this.screens.size === 0) return;
    this.io.to(this.screenChannel).emit(EV.EVENT_SPLASH, {
      kind,
      x: clamp(x, -TANK.halfWidth, TANK.halfWidth),
      z: clamp(z, -TANK.halfDepth, TANK.halfDepth),
      strength: clamp(strength, 0, 1),
      playerNumber,
    });
  }
}

const startXFor = (seat: number): number =>
  POI_START_X[(seat - 1) % POI_START_X.length] ?? 0;

const hashString = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

/** Re-exported so the manager can keep its imports tidy. */
export type { DropReason };
