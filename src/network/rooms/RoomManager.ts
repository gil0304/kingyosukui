/**
 * Owns the set of live rooms and wires every socket to the right one.
 * Server-only.
 */

import type { Server, Socket } from 'socket.io';

import { GameRoom } from './GameRoom';
import {
  EV,
  type AdminCommand,
  type PlayerJoinPayload,
  type PlayerReadyPayload,
  type ScreenJoinPayload,
} from '@/network/protocol/events';

/** Rooms are cheap, but an abandoned one should not tick forever. */
const IDLE_TTL_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30_000;

export const normalizeRoomId = (raw: string): string =>
  (raw || 'DEFAULT')
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 24) || 'DEFAULT';

export class RoomManager {
  private readonly io: Server;
  private readonly rooms = new Map<string, GameRoom>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(io: Server) {
    this.io = io;
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
  }

  get(id: string): GameRoom {
    const key = normalizeRoomId(id);
    let room = this.rooms.get(key);
    if (!room) {
      room = new GameRoom(key, this.io);
      this.rooms.set(key, room);
    }
    return room;
  }

  find(id: string): GameRoom | undefined {
    return this.rooms.get(normalizeRoomId(id));
  }

  remove(id: string): void {
    const key = normalizeRoomId(id);
    this.rooms.get(key)?.dispose();
    this.rooms.delete(key);
  }

  list(): GameRoom[] {
    return [...this.rooms.values()];
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, room] of this.rooms) {
      if (room.isEmpty && now - room.lastActivity > IDLE_TTL_MS) {
        room.dispose();
        this.rooms.delete(id);
      }
    }
  }

  /** Wires every protocol handler for one connection. */
  bind(socket: Socket): void {
    let boundRoom: GameRoom | null = null;

    socket.on(EV.SCREEN_JOIN, (p: ScreenJoinPayload, ack?: (r: { ok: boolean }) => void) => {
      const room = this.get(p?.roomId ?? '');
      boundRoom = room;
      room.attachScreen(socket);
      ack?.({ ok: true });
    });

    socket.on(EV.ADMIN_JOIN, (p: ScreenJoinPayload, ack?: (r: { ok: boolean }) => void) => {
      const room = this.get(p?.roomId ?? '');
      boundRoom = room;
      room.attachAdmin(socket);
      ack?.({ ok: true });
    });

    socket.on(EV.PLAYER_JOIN, (p: PlayerJoinPayload, ack?: (r: unknown) => void) => {
      const room = this.get(p?.roomId ?? '');
      boundRoom = room;
      const result = room.join(socket, p ?? { roomId: '' });
      ack?.(result);
      if (!result.ok) {
        socket.emit(EV.ERROR, { code: result.reason ?? 'JOIN_FAILED', message: '参加できませんでした' });
      }
    });

    socket.on(EV.PLAYER_READY, (p: PlayerReadyPayload) => {
      boundRoom?.handleReady(socket.id, p ?? { controllerReady: false });
    });

    socket.on(EV.CONTROLLER_CALIBRATED, () => {
      boundRoom?.handleCalibrated(socket.id);
    });

    socket.on(EV.CONTROLLER_INPUT, (buf: ArrayBuffer | Buffer | Uint8Array) => {
      if (!buf) return;
      boundRoom?.handleInput(socket.id, buf);
    });

    socket.on(EV.ADMIN_COMMAND, (cmd: AdminCommand) => {
      if (!cmd || typeof cmd.type !== 'string') return;
      boundRoom?.handleAdminCommand(cmd);
    });

    socket.on(EV.PLAYER_LEAVE, () => {
      boundRoom?.detach(socket.id);
    });

    // Round-trip probe so the phone can show its latency (spec §39).
    socket.on(EV.PING, (p: { clientTime: number }) => {
      socket.emit(EV.PONG, { clientTime: p?.clientTime ?? 0, serverTime: Date.now() });
    });

    socket.on('disconnect', () => {
      boundRoom?.detach(socket.id);
      boundRoom = null;
    });
  }

  dispose(): void {
    clearInterval(this.sweeper);
    for (const room of this.rooms.values()) room.dispose();
    this.rooms.clear();
  }
}
