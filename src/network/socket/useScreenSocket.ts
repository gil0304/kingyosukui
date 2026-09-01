'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { FishSnapshotBuffer, PoiStateBuffer } from '@/network/state/snapshotBuffer';
import { asArrayBuffer, createSignal, createSocket } from './socketClient';
import { EV, type AdminCommand } from '@/network/protocol/events';
import type {
  CapturePayload,
  DropPayload,
  PhasePayload,
  PlayerJoinedPayload,
  PlayerLeftPayload,
  PoiBreakPayload,
  PoiRespawnPayload,
  RareSpawnPayload,
  SplashPayload,
} from '@/network/protocol/events';
import type { GameResult, RoomPublicState } from '@/types';
import { nowSeconds } from '@/game/core/math';

export interface ScreenSocketApi {
  /** Operator commands from the projector machine (START, RESET, …). */
  send(cmd: AdminCommand): void;
  room: RoomPublicState | null;
  phase: PhasePayload | null;
  connected: boolean;
  fishBuffer: FishSnapshotBuffer;
  poiBuffer: PoiStateBuffer;
  onCapture(cb: (p: CapturePayload) => void): () => void;
  onDrop(cb: (p: DropPayload) => void): () => void;
  onBreak(cb: (p: PoiBreakPayload) => void): () => void;
  onRespawn(cb: (p: PoiRespawnPayload) => void): () => void;
  onSplash(cb: (p: SplashPayload) => void): () => void;
  onJoined(cb: (p: PlayerJoinedPayload) => void): () => void;
  onLeft(cb: (p: PlayerLeftPayload) => void): () => void;
  onRare(cb: (p: RareSpawnPayload) => void): () => void;
  onResult(cb: (p: GameResult) => void): () => void;
}

export function useScreenSocket(roomId: string): ScreenSocketApi {
  const socketRef = useRef<ReturnType<typeof createSocket> | null>(null);
  const [room, setRoom] = useState<RoomPublicState | null>(null);
  const [phase, setPhase] = useState<PhasePayload | null>(null);
  const [connected, setConnected] = useState(false);

  const fishBuffer = useMemo(() => new FishSnapshotBuffer(), []);
  const poiBuffer = useMemo(() => new PoiStateBuffer(), []);

  const signals = useMemo(
    () => ({
      capture: createSignal<CapturePayload>(),
      drop: createSignal<DropPayload>(),
      brk: createSignal<PoiBreakPayload>(),
      respawn: createSignal<PoiRespawnPayload>(),
      splash: createSignal<SplashPayload>(),
      joined: createSignal<PlayerJoinedPayload>(),
      left: createSignal<PlayerLeftPayload>(),
      rare: createSignal<RareSpawnPayload>(),
      result: createSignal<GameResult>(),
    }),
    [],
  );

  const roomIdRef = useRef(roomId);
  roomIdRef.current = roomId;

  useEffect(() => {
    const socket = createSocket();
    socketRef.current = socket;

    const announce = () => socket.emit(EV.SCREEN_JOIN, { roomId: roomIdRef.current });

    socket.on('connect', () => {
      setConnected(true);
      announce();
    });
    socket.on('disconnect', () => {
      setConnected(false);
      fishBuffer.clear();
      poiBuffer.clear();
    });

    socket.on(EV.ROOM_STATE, (p: RoomPublicState) => setRoom(p));
    socket.on(EV.PHASE, (p: PhasePayload) => setPhase(p));
    socket.on(EV.SNAPSHOT_FISH, (raw: unknown) => {
      const buf = asArrayBuffer(raw);
      if (buf) fishBuffer.push(buf, nowSeconds());
    });
    socket.on(EV.SNAPSHOT_POI, (raw: unknown) => {
      const buf = asArrayBuffer(raw);
      if (buf) poiBuffer.push(buf, nowSeconds());
    });
    socket.on(EV.EVENT_CAPTURE, (p: CapturePayload) => signals.capture.emit(p));
    socket.on(EV.EVENT_DROP, (p: DropPayload) => signals.drop.emit(p));
    socket.on(EV.EVENT_POI_BREAK, (p: PoiBreakPayload) => signals.brk.emit(p));
    socket.on(EV.EVENT_POI_RESPAWN, (p: PoiRespawnPayload) => signals.respawn.emit(p));
    socket.on(EV.EVENT_SPLASH, (p: SplashPayload) => signals.splash.emit(p));
    socket.on(EV.EVENT_PLAYER_JOINED, (p: PlayerJoinedPayload) => signals.joined.emit(p));
    socket.on(EV.EVENT_PLAYER_LEFT, (p: PlayerLeftPayload) => signals.left.emit(p));
    socket.on(EV.EVENT_RARE_SPAWN, (p: RareSpawnPayload) => signals.rare.emit(p));
    socket.on(EV.RESULT, (p: GameResult) => signals.result.emit(p));

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [fishBuffer, poiBuffer, signals]);

  const send = useCallback((cmd: AdminCommand) => {
    socketRef.current?.emit(EV.ADMIN_COMMAND, cmd);
  }, []);

  return useMemo<ScreenSocketApi>(
    () => ({
      send,
      room,
      phase,
      connected,
      fishBuffer,
      poiBuffer,
      onCapture: signals.capture.subscribe,
      onDrop: signals.drop.subscribe,
      onBreak: signals.brk.subscribe,
      onRespawn: signals.respawn.subscribe,
      onSplash: signals.splash.subscribe,
      onJoined: signals.joined.subscribe,
      onLeft: signals.left.subscribe,
      onRare: signals.rare.subscribe,
      onResult: signals.result.subscribe,
    }),
    [send, room, phase, connected, fishBuffer, poiBuffer, signals],
  );
}
