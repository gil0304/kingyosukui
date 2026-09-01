'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { GAME } from '@/game/core/constants';
import { nowSeconds } from '@/game/core/math';
import { encodeInput } from '@/network/protocol/codec';
import { EV, type BowlStatePayload, type CapturePayload, type ErrorPayload, type PhasePayload, type PlayerJoinAck, type PoiBreakPayload, type PongPayload } from '@/network/protocol/events';
import { SensorAdapter } from '@/controller/sensors/sensorAdapter';
import { detectMotionCapabilities, requestMotionPermission } from '@/controller/sensors/permission';
import { createSignal, createSocket } from './socketClient';
import type { ControllerStatus, GameResult, RoomPublicState } from '@/types';

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
  calibrating: boolean;
  join(): Promise<void>;
  leave(): void;
  onCapture(cb: (p: CapturePayload) => void): () => void;
  onBreak(cb: (p: PoiBreakPayload) => void): () => void;
  readonly adapter: SensorAdapter | null;
}

const TOKEN_KEY = (roomId: string) => `kingyo.resume.${roomId}`;

const IDLE_STATUS: ControllerStatus = {
  supported: true,
  permission: 'unknown',
  sampleRate: 0,
  hasOrientation: false,
  hasMotion: false,
  gravityOnly: false,
};

export function useControllerSocket(roomId: string): ControllerSocketApi {
  const [connected, setConnected] = useState(false);
  const [joinPhase, setJoinPhase] = useState<JoinPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [playerNumber, setPlayerNumber] = useState(0);
  const [color, setColor] = useState('#ffffff');
  const [spectating, setSpectating] = useState(false);
  const [room, setRoom] = useState<RoomPublicState | null>(null);
  const [phase, setPhase] = useState<PhasePayload | null>(null);
  const [bowl, setBowl] = useState<BowlStatePayload | null>(null);
  const [result, setResult] = useState<GameResult | null>(null);
  const [status, setStatus] = useState<ControllerStatus>(IDLE_STATUS);
  const [latencyMs, setLatencyMs] = useState(0);
  const [calibrating, setCalibrating] = useState(false);

  const socketRef = useRef<ReturnType<typeof createSocket> | null>(null);
  const adapterRef = useRef<SensorAdapter | null>(null);
  const rafRef = useRef(0);
  const lastSendRef = useRef(0);
  const calibrateUntilRef = useRef(0);
  const joinedRef = useRef(false);

  const signals = useMemo(
    () => ({ capture: createSignal<CapturePayload>(), brk: createSignal<PoiBreakPayload>() }),
    [],
  );

  // --- socket ------------------------------------------------------------
  useEffect(() => {
    const socket = createSocket();
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      // Reclaim our seat after a reload or a Wi-Fi blip (spec §84).
      if (joinedRef.current) void doJoin(true);
    });
    socket.on('disconnect', () => setConnected(false));

    socket.on(EV.ROOM_STATE, (p: RoomPublicState) => {
      setRoom(p);
      // The join ack's 'spectating' is only true at the instant of joining. The server
      // promotes everyone into the next round when the room returns to WAITING, so this
      // has to track the authoritative value — otherwise a player who joined mid-round
      // is told "next game" for the rest of the evening and never plays.
      const id = playerIdRef.current;
      if (id) {
        const me = p.players.find((x) => x.id === id);
        if (me) setSpectating(me.spectating);
      }
    });
    socket.on(EV.PHASE, (p: PhasePayload) => {
      setPhase(p);
      if (p.state !== 'RESULT') setResult(null);
    });
    socket.on(EV.BOWL_STATE, (p: BowlStatePayload) => {
      setBowl(p);
      // Let the gesture machine know whether the poi is really in the water
      // (spec §34: a lift only counts from inside the water).
      adapterRef.current?.setPoiInWater(
        p.poiState === 'Submerged' || p.poiState === 'Entering' || p.poiState === 'Lifting',
      );
    });
    socket.on(EV.RESULT, (p: GameResult) => setResult(p));
    socket.on(EV.EVENT_CAPTURE, (p: CapturePayload) => {
      if (p.playerId === playerIdRef.current) signals.capture.emit(p);
    });
    socket.on(EV.EVENT_POI_BREAK, (p: PoiBreakPayload) => {
      if (p.playerId === playerIdRef.current) signals.brk.emit(p);
    });
    socket.on(EV.ERROR, (p: ErrorPayload) => setError(p.message));
    socket.on(EV.PONG, (p: PongPayload) => {
      setLatencyMs(Math.max(0, Math.round(Date.now() - p.clientTime)));
    });

    // Spec §28: the phone calibrates itself while the giant screen counts down.
    socket.on(EV.CALIBRATE_REQUEST, (p: { durationSeconds: number }) => {
      const adapter = adapterRef.current;
      if (!adapter) return;
      adapter.beginCalibration();
      setCalibrating(true);
      calibrateUntilRef.current = nowSeconds() + Math.max(1, p.durationSeconds);
    });

    const ping = setInterval(() => {
      socket.emit(EV.PING, { clientTime: Date.now() });
    }, 2000);

    return () => {
      clearInterval(ping);
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signals]);

  const playerIdRef = useRef<string | null>(null);
  playerIdRef.current = playerId;

  // --- join --------------------------------------------------------------
  const doJoin = useCallback(
    async (silent: boolean) => {
      const socket = socketRef.current;
      if (!socket) return;
      if (!silent) setJoinPhase('joining');
      const token =
        typeof window !== 'undefined' ? window.localStorage.getItem(TOKEN_KEY(roomId)) : null;

      const ack = await new Promise<PlayerJoinAck>((resolve) => {
        socket.emit(
          EV.PLAYER_JOIN,
          { roomId, resumeToken: token ?? undefined },
          (r: PlayerJoinAck) => resolve(r),
        );
        setTimeout(() => resolve({ ok: false, reason: 'ROOM_NOT_FOUND' }), 6000);
      });

      if (!ack.ok) {
        joinedRef.current = false;
        setJoinPhase('error');
        setError(
          ack.reason === 'ROOM_FULL'
            ? 'この水槽は満員です。少し待ってからもう一度お試しください。'
            : '参加できませんでした。もう一度お試しください。',
        );
        return;
      }

      joinedRef.current = true;
      setPlayerId(ack.playerId ?? null);
      setPlayerNumber(ack.playerNumber ?? 0);
      setColor(ack.color ?? '#ffffff');
      setSpectating(!!ack.spectating);
      if (ack.room) setRoom(ack.room);
      if (ack.resumeToken && typeof window !== 'undefined') {
        window.localStorage.setItem(TOKEN_KEY(roomId), ack.resumeToken);
      }
      setJoinPhase('joined');
      setError(null);

      const adapter = adapterRef.current;
      if (adapter && ack.playerId) adapter.setPlayerId(ack.playerId);
      socket.emit(EV.PLAYER_READY, {
        controllerReady: true,
        status: adapter
          ? {
              hasOrientation: adapter.status.hasOrientation,
              hasMotion: adapter.status.hasMotion,
              gravityOnly: adapter.status.gravityOnly,
            }
          : undefined,
      });
    },
    [roomId],
  );

  const join = useCallback(async () => {
    setError(null);
    setJoinPhase('requesting');

    const debug =
      typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug');

    // iOS 13+ requires this call to happen inside the tap handler.
    const permission = debug ? 'granted' : await requestMotionPermission();
    if (permission === 'denied') {
      setJoinPhase('error');
      const caps = detectMotionCapabilities();
      setError(
        !caps.secureContext
          ? 'このページは安全な接続(https)で開かれていないため、モーションセンサーを使えません。スクリーンのQRコードから開き直してください。'
          : 'モーションセンサーの利用が許可されませんでした。もう一度タップして「許可」を選んでください。' +
              '\n\niPhone: 設定 → Safari →「モーションと画面の向きのアクセス」をオンにしてから、' +
              'ページを再読み込みしてください。',
      );
      return;
    }

    const adapter = new SensorAdapter({ playerId: 'pending', debug });
    adapter.start();
    adapterRef.current = adapter;
    setStatus({ ...adapter.status, permission });

    if (permission === 'unsupported' && !debug) {
      setJoinPhase('error');
      setError('この端末ではモーションセンサーを利用できません。');
      return;
    }

    await doJoin(false);
  }, [doJoin]);

  const leave = useCallback(() => {
    socketRef.current?.emit(EV.PLAYER_LEAVE);
    joinedRef.current = false;
    adapterRef.current?.stop();
    adapterRef.current = null;
    setJoinPhase('idle');
  }, []);

  // --- 60 Hz input loop --------------------------------------------------
  useEffect(() => {
    if (joinPhase !== 'joined') return;
    const interval = 1 / GAME.controllerHz;

    const frame = () => {
      rafRef.current = requestAnimationFrame(frame);
      const adapter = adapterRef.current;
      const socket = socketRef.current;
      if (!adapter || !socket) return;

      const t = nowSeconds();
      const state = adapter.sample(t);

      // Finish the automatic calibration window (spec §29: no phone button).
      if (calibrateUntilRef.current > 0 && t >= calibrateUntilRef.current) {
        calibrateUntilRef.current = 0;
        const ok = adapter.finishCalibration();
        setCalibrating(false);
        socket.emit(EV.CONTROLLER_CALIBRATED, { ok });
      }

      if (t - lastSendRef.current < interval) return;
      lastSendRef.current = t;

      // volatile: a late input packet is worthless — drop it rather than queue it.
      socket.volatile.emit(
        EV.CONTROLLER_INPUT,
        encodeInput({
          timeMs: Date.now(),
          x: state.x,
          y: state.y,
          tiltX: state.tiltX,
          tiltY: state.tiltY,
          tiltZ: state.tiltZ,
          verticalAcceleration: state.verticalAcceleration,
          handOffsetY: state.handOffsetY,
          handVelocityY: state.handVelocityY,
          liftPeakAccel: state.liftPeakAccel,
          isSubmerging: state.isSubmerging,
          isLifting: state.isLifting,
          shake: state.shake,
        }),
      );
    };

    rafRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafRef.current);
  }, [joinPhase]);

  // Refresh the reported sensor status once a second — it settles after a moment.
  useEffect(() => {
    if (joinPhase !== 'joined') return;
    const id = setInterval(() => {
      const a = adapterRef.current;
      if (a) setStatus({ ...a.status });
    }, 1000);
    return () => clearInterval(id);
  }, [joinPhase]);

  // Keep the screen awake: a phone that sleeps mid-round stops being a poi.
  useEffect(() => {
    if (joinPhase !== 'joined') return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;
    const request = async () => {
      try {
        const wl = (navigator as Navigator & { wakeLock?: WakeLock }).wakeLock;
        if (!wl) return;
        const s = await wl.request('screen');
        if (cancelled) void s.release();
        else sentinel = s;
      } catch {
        /* not fatal */
      }
    };
    void request();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void request();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release();
    };
  }, [joinPhase]);

  useEffect(() => () => adapterRef.current?.stop(), []);

  return {
    connected,
    joinPhase,
    error,
    playerId,
    playerNumber,
    color,
    spectating,
    room,
    phase,
    bowl,
    result,
    status,
    latencyMs,
    calibrating,
    join,
    leave,
    onCapture: signals.capture.subscribe,
    onBreak: signals.brk.subscribe,
    adapter: adapterRef.current,
  };
}
