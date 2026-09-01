/**
 * A minimal stand-in for the socket.io Server / Socket pair that GameRoom uses.
 *
 * GameRoom only ever touches four things:
 *   io.to(channel).emit(event, payload)
 *   socket.id
 *   socket.join(channel)
 *   socket.emit(event, payload)
 *
 * so that is all this fake implements. Every emit — whether it went through a
 * channel or straight to one socket — is recorded in a single flat log, which
 * makes assertions read the same way in both cases: a direct socket emit is
 * recorded under the socket's own id, exactly the channel string GameRoom uses
 * when it addresses one phone via io.to(socketId).
 */

import type { Server, Socket } from 'socket.io';

export interface EmittedEvent {
  /** Room / channel name, or a socket id for a direct emit. */
  channel: string;
  event: string;
  payload: unknown;
}

interface FakeBroadcast {
  emit(event: string, payload?: unknown): boolean;
}

export class FakeSocket {
  readonly id: string;
  /** Channels this socket has been put into, in order. */
  readonly joined: string[] = [];
  readonly rooms = new Set<string>();

  private readonly io: FakeIo;

  constructor(io: FakeIo, id: string) {
    this.io = io;
    this.id = id;
  }

  join(channel: string): void {
    this.joined.push(channel);
    this.rooms.add(channel);
  }

  leave(channel: string): void {
    this.rooms.delete(channel);
  }

  emit(event: string, payload?: unknown): boolean {
    this.io.record(this.id, event, payload);
    return true;
  }

  /** Everything this socket received directly, in order. */
  get received(): EmittedEvent[] {
    return this.io.emits.filter((e) => e.channel === this.id);
  }

  /** The shape GameRoom expects. The fake covers every member it touches. */
  get asSocket(): Socket {
    return this as unknown as Socket;
  }
}

export class FakeIo {
  /** Every emit, in order, from every channel and every socket. */
  readonly emits: EmittedEvent[] = [];

  private readonly broadcasts = new Map<string, FakeBroadcast>();
  private nextSocket = 1;

  /** Create a new socket with a unique id. */
  connect(id?: string): FakeSocket {
    return new FakeSocket(this, id ?? `sock-${this.nextSocket++}`);
  }

  to(channel: string): FakeBroadcast {
    let op = this.broadcasts.get(channel);
    if (!op) {
      op = {
        emit: (event: string, payload?: unknown): boolean => {
          this.record(channel, event, payload);
          return true;
        },
      };
      this.broadcasts.set(channel, op);
    }
    return op;
  }

  record(channel: string, event: string, payload: unknown): void {
    this.emits.push({ channel, event, payload });
  }

  clear(): void {
    this.emits.length = 0;
  }

  get asServer(): Server {
    return this as unknown as Server;
  }
}

// ---------------------------------------------------------------------------
// query helpers
// ---------------------------------------------------------------------------

/** Every emit of 'event' (optionally restricted to one channel), in order. */
export const eventsNamed = (
  io: FakeIo,
  event: string,
  channel?: string,
): EmittedEvent[] =>
  io.emits.filter((e) => e.event === event && (channel === undefined || e.channel === channel));

/** Payloads of every emit of 'event', typed by the caller. */
export const payloadsOf = <T>(io: FakeIo, event: string, channel?: string): T[] =>
  eventsNamed(io, event, channel).map((e) => e.payload as T);

/** The most recent payload for 'event', or undefined if it never fired. */
export const lastPayloadOf = <T>(
  io: FakeIo,
  event: string,
  channel?: string,
): T | undefined => {
  const all = payloadsOf<T>(io, event, channel);
  return all.length > 0 ? all[all.length - 1] : undefined;
};

export const countOf = (io: FakeIo, event: string, channel?: string): number =>
  eventsNamed(io, event, channel).length;
