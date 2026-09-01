'use client';

import { io, type Socket } from 'socket.io-client';

/**
 * One socket per page. The venue runs everything on a single origin, so the
 * default (same-origin) connection is always correct.
 */
export const createSocket = (): Socket =>
  io({
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 400,
    reconnectionDelayMax: 2000,
    reconnectionAttempts: Infinity,
    timeout: 8000,
  });

/**
 * Tiny subscription registry so high-frequency game events can reach effects
 * (splashes, sounds, slow motion) without triggering a React re-render.
 */
export const createSignal = <T>() => {
  const listeners = new Set<(v: T) => void>();
  return {
    subscribe(cb: (v: T) => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit(v: T): void {
      for (const cb of listeners) {
        try {
          cb(v);
        } catch (err) {
          // A broken effect must never take the tank down mid-show.
          // eslint-disable-next-line no-console
          console.error('signal listener failed', err);
        }
      }
    },
    clear(): void {
      listeners.clear();
    },
  };
};

export type Signal<T> = ReturnType<typeof createSignal<T>>;

/** socket.io hands binary over as ArrayBuffer in browsers, Buffer under Node. */
export const asArrayBuffer = (data: unknown): ArrayBuffer | null => {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }
  return null;
};
