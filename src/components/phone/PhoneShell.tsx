'use client';

/**
 * The whole smartphone client, composed (spec §20-§24, §85-§96, §106).
 *
 * The phone is two things and nothing else: a physical poi, and a private
 * goldfish bowl. It is not a second screen for the game — the game is on the
 * wall. So this shell renders a readout and a bowl, and it contains no control
 * of any kind: no joystick, no d-pad, no scoop button, no tap-to-catch, no
 * swipe, no slider (spec §23). Touching this page cannot make a player better at
 * the game, and the only tap in the entire installation is 参加する on the join
 * gate, which exists purely because iOS will not grant motion access without a
 * real user gesture (spec §20).
 *
 * Layout rules that come from the venue rather than from the spec:
 *  - it fills the viewport with 100dvh and never scrolls, so the phone can be
 *    held at any angle without the page sliding around;
 *  - safe-area insets are honoured on all four edges;
 *  - the score, the fish count and the clock all use tabular figures inside
 *    fixed-size boxes, so the layout does not twitch when a fish is scooped —
 *    a player watching the giant screen should never be pulled back by motion
 *    in the corner of their eye.
 *
 * Two loops run here. The controller hook owns the 60 Hz sensor sample and
 * input send; this component only samples 'adapter.state.tiltX' at roughly
 * 12 Hz for the decorative bowl tilt (spec §93), and only commits a React state
 * update when the angle actually moved. Re-rendering the shell 60 times a second
 * to animate a water line would be an absurd way to spend a phone battery.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import { audio } from '@/audio/AudioEngine';
import { GAME, POI } from '@/game/core/constants';
import { useControllerSocket } from '@/network/socket/useControllerSocket';
import { BowlCanvas } from '@/smartphone/bowl/BowlCanvas';
import { PhoneResult } from '@/smartphone/result/PhoneResult';
import { PoiStatus } from '@/smartphone/status/PoiStatus';
import { StatusBar } from '@/smartphone/status/StatusBar';
import {
  POI_VERTICAL_STATES,
  type CapturedFish,
  type PoiVerticalState,
  type RoomState,
} from '@/types';

import { CalibrationOverlay } from './CalibrationOverlay';
import { ConnectionBadge } from './ConnectionBadge';
import { HowToPlay } from './HowToPlay';
import { JoinGate } from './JoinGate';

/** Stable empty list so the bowl never sees a fresh array identity per render. */
const EMPTY_FISH: readonly CapturedFish[] = [];

/** Roughly 12 Hz — smooth enough for a water line, cheap enough for a phone. */
const TILT_INTERVAL_MS = 82;
/** About 0.7 degrees. Below this the bowl would not visibly move anyway. */
const TILT_EPSILON = 0.012;

const ROOT: CSSProperties = {
  height: '100dvh',
  width: '100%',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background:
    'radial-gradient(130% 78% at 50% 0%, rgba(24,32,58,0.96) 0%, rgba(8,11,20,1) 60%, rgba(5,6,12,1) 100%)',
  color: 'var(--ink, #f4efe4)',
  fontFamily: 'var(--font-ui, system-ui, sans-serif)',
};

const BOTTOM: CSSProperties = {
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 9,
  padding:
    '12px calc(env(safe-area-inset-right, 0px) + 14px) calc(env(safe-area-inset-bottom, 0px) + 10px) calc(env(safe-area-inset-left, 0px) + 14px)',
  background:
    'linear-gradient(180deg, rgba(7,11,20,0) 0%, rgba(7,11,20,0.82) 26%, rgba(7,11,20,0.97) 100%)',
};

/** Spec §88: the one line of guidance that stays on screen while playing. */
const QUIET_LINE: CSSProperties = {
  textAlign: 'center',
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: '0.09em',
  lineHeight: 1.2,
  color: 'rgba(198,216,232,0.6)',
};

const CENTER_PANE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 18,
  textAlign: 'center',
  padding:
    'calc(env(safe-area-inset-top, 0px) + 24px) calc(env(safe-area-inset-right, 0px) + 24px) calc(env(safe-area-inset-bottom, 0px) + 24px) calc(env(safe-area-inset-left, 0px) + 24px)',
};

/** A short buzz in the hand, so a player watching the wall still feels the catch. */
const vibrate = (pattern: number | number[]): void => {
  if (typeof navigator === 'undefined') return;
  if (typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* Vibration is a courtesy, never a requirement. */
  }
};

const toPoiState = (raw: string | undefined): PoiVerticalState => {
  for (const s of POI_VERTICAL_STATES) if (s === raw) return s;
  return 'Above';
};

/**
 * Reads the live roll straight off the sensor adapter and hands it to the bowl.
 *
 * Kept as its own component on purpose: the 12 Hz tilt updates re-render this
 * subtree and nothing else, so the status bar, the paper readout and the count-up
 * animations are untouched by the water sloshing.
 */
/**
 * The touch steering surface (owner redesign, 2026-08-26, amending spec §23):
 * press toward the right edge and the poi glides right; the left edge, left;
 * the top half sends it deeper into the tank, the bottom half brings it home.
 * Vertical action — into the water, and the scoop — stays on the phone's PITCH.
 *
 * The whole play area is the pad. Finger position relative to the centre is a
 * velocity, streamed straight into the SensorAdapter; letting go stops the poi
 * where it is. No visible joystick: two faint edge chevrons carry the idea.
 */
function TouchSteer({
  setVector,
  children,
}: {
  setVector: (x: number, y: number) => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const activeId = useRef<number | null>(null);
  const [pressed, setPressed] = useState<0 | -1 | 1>(0);

  const update = useCallback(
    (clientX: number, clientY: number) => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const nx = ((clientX - r.left) / r.width) * 2 - 1;
      const ny = 1 - ((clientY - r.top) / r.height) * 2; // +1 at the top edge
      setVector(Math.max(-1, Math.min(1, nx)), Math.max(-1, Math.min(1, ny)));
      setPressed(nx > 0.15 ? 1 : nx < -0.15 ? -1 : 0);
    },
    [setVector],
  );

  const stop = useCallback(() => {
    activeId.current = null;
    setVector(0, 0);
    setPressed(0);
  }, [setVector]);

  useEffect(() => stop, [stop]);

  const chevron = (side: -1 | 1): CSSProperties => ({
    position: 'absolute',
    top: '50%',
    [side < 0 ? 'left' : 'right']: 6,
    transform: 'translateY(-50%)',
    fontSize: 26,
    lineHeight: 1,
    color: pressed === side ? 'var(--lantern, #ffb64d)' : 'rgba(198,216,232,0.28)',
    transition: 'color 120ms ease-out',
    pointerEvents: 'none',
    userSelect: 'none',
  });

  return (
    <div
      ref={ref}
      style={{ position: 'absolute', inset: 0, touchAction: 'none' }}
      onPointerDown={(e) => {
        activeId.current = e.pointerId;
        update(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (activeId.current === e.pointerId) update(e.clientX, e.clientY);
      }}
      onPointerUp={(e) => {
        if (activeId.current === e.pointerId) stop();
      }}
      onPointerCancel={stop}
      onPointerLeave={(e) => {
        if (activeId.current === e.pointerId) stop();
      }}
    >
      {children}
      <span style={chevron(-1)}>‹</span>
      <span style={chevron(1)}>›</span>
    </div>
  );
}

function TiltedBowl({
  capturedFish,
  getTilt,
}: {
  capturedFish: readonly CapturedFish[];
  getTilt: () => number;
}) {
  const [tilt, setTilt] = useState(0);
  const getRef = useRef(getTilt);
  getRef.current = getTilt;

  useEffect(() => {
    let raf = 0;
    let lastSampleMs = -1e9;
    let committed = 0;

    const loop = (ms: number) => {
      raf = requestAnimationFrame(loop);
      if (ms - lastSampleMs < TILT_INTERVAL_MS) return;
      lastSampleMs = ms;

      const v = getRef.current();
      if (!Number.isFinite(v)) return;
      if (Math.abs(v - committed) < TILT_EPSILON) return;
      committed = v;
      setTilt(v);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <BowlCanvas
      capturedFish={capturedFish}
      tilt={tilt}
      style={{ position: 'absolute', inset: 0, minHeight: 0 }}
    />
  );
}

/** joinPhase 'requesting' / 'joining' — calm, and honest about what is happening. */
function Preparing({ joining }: { joining: boolean }) {
  return (
    <div style={CENTER_PANE} className="fade-in">
      <style>
        {'@keyframes kgs-prep-dot{0%,80%,100%{opacity:0.2;transform:translateY(0)}40%{opacity:1;transform:translateY(-5px)}}'}
      </style>

      <div style={{ display: 'flex', gap: 10 }}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              width: 11,
              height: 11,
              borderRadius: 11,
              background: 'var(--lantern)',
              animation: `kgs-prep-dot 1.25s ease-in-out ${i * 0.16}s infinite`,
            }}
          />
        ))}
      </div>

      <div
        style={{
          fontSize: 'clamp(19px, 5.6vw, 24px)',
          fontWeight: 800,
          lineHeight: 1.4,
          color: 'var(--ink)',
        }}
      >
        {joining ? '水槽につないでいます…' : 'センサーを準備しています…'}
      </div>

      <div style={{ fontSize: 14, lineHeight: 1.75, color: 'var(--ink-dim)', maxWidth: 320 }}>
        {joining
          ? 'そのまま少しお待ちください。'
          : '許可を求めるダイアログが出たら「許可」を選んでください。'}
      </div>
    </div>
  );
}

/** joinPhase 'error' — say what went wrong, then say exactly how to fix it. */
function ErrorPane({
  message,
  sensorProblem,
  onRetry,
}: {
  message: string;
  sensorProblem: boolean;
  onRetry: () => void;
}) {
  return (
    <div style={{ ...CENTER_PANE, justifyContent: 'center', gap: 16 }} className="fade-in">
      <div
        style={{
          fontSize: 'clamp(20px, 6vw, 25px)',
          fontWeight: 900,
          color: '#ff8a76',
          lineHeight: 1.35,
        }}
      >
        {sensorProblem ? 'センサーを使えませんでした' : '参加できませんでした'}
      </div>

      <div
        style={{
          fontSize: 15,
          lineHeight: 1.75,
          color: 'rgba(226,238,248,0.9)',
          maxWidth: 340,
          whiteSpace: 'pre-line',
        }}
      >
        {message}
      </div>

      <button
        type="button"
        onClick={onRetry}
        style={{
          width: '100%',
          maxWidth: 360,
          minHeight: 68,
          border: 'none',
          borderRadius: 16,
          background:
            'linear-gradient(170deg, var(--lantern, #ffb64d) 0%, var(--lantern-deep, #e2612b) 100%)',
          backgroundColor: '#ffb64d',
          color: '#20120a',
          fontFamily: 'var(--font-ui, system-ui, sans-serif)',
          fontSize: 22,
          fontWeight: 900,
          letterSpacing: '0.2em',
          textIndent: '0.2em',
          cursor: 'pointer',
          WebkitTapHighlightColor: 'transparent',
          touchAction: 'manipulation',
        }}
      >
        もう一度
      </button>

      {sensorProblem && (
        <div
          style={{
            textAlign: 'left',
            maxWidth: 360,
            padding: '14px 16px',
            borderRadius: 14,
            background: 'rgba(21,26,48,0.8)',
            border: '1px solid rgba(255,182,77,0.24)',
            fontSize: 13,
            lineHeight: 1.8,
            color: 'rgba(226,238,248,0.88)',
          }}
        >
          <div style={{ fontWeight: 800, color: 'var(--lantern)', marginBottom: 6 }}>
            うまくいかないときは
          </div>
          <div style={{ marginBottom: 8 }}>
            <strong>iPhone:</strong> 設定 &gt; Safari &gt; モーションと画面の向きのアクセス
            をオンにしてから、このページを開き直してください。
          </div>
          <div style={{ marginBottom: 8 }}>
            <strong>Android:</strong>{' '}
            ブラウザのサイト設定でモーションセンサーを許可してください。
          </div>
          <div style={{ color: 'var(--ink-dim)' }}>
            センサーは HTTPS でのみ動作します。アドレスが https で始まっていないときは、
            スクリーンのQRコードから開き直してください。
          </div>
        </div>
      )}
    </div>
  );
}

/** Spec §85: a late joiner keeps their bowl on screen and waits for the next round. */
function SpectateBanner() {
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 20,
        padding: '18px 18px 34px',
        textAlign: 'center',
        pointerEvents: 'none',
        background:
          'linear-gradient(180deg, rgba(8,12,20,0.96) 0%, rgba(8,12,20,0.72) 55%, rgba(8,12,20,0) 100%)',
      }}
    >
      <style>
        {'@keyframes kgs-wait-pulse{0%,100%{opacity:0.55}50%{opacity:1}}'}
      </style>
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 18px 11px',
          borderRadius: 999,
          border: '1px solid rgba(255,182,77,0.5)',
          background: 'rgba(255,182,77,0.1)',
        }}
      >
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: 10,
            background: 'var(--lantern)',
            animation: 'kgs-wait-pulse 1.6s ease-in-out infinite',
          }}
        />
        <span
          style={{
            fontSize: 'clamp(18px, 5.4vw, 23px)',
            fontWeight: 900,
            letterSpacing: '0.04em',
            color: 'var(--lantern)',
          }}
        >
          次のゲームに参加します
        </span>
      </div>
      <div
        style={{
          marginTop: 10,
          fontSize: 13.5,
          lineHeight: 1.7,
          color: 'rgba(226,238,248,0.82)',
        }}
      >
        いまのゲームが終わるまで お待ちください。
        <br />
        そのまま スマホを持っていてください。
      </div>
    </div>
  );
}

/** WAITING: the round has not started. Remind them how it works, quietly. */
function WaitingPane() {
  return (
    <>
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 20,
          padding: '16px 18px 30px',
          textAlign: 'center',
          pointerEvents: 'none',
          background:
            'linear-gradient(180deg, rgba(8,12,20,0.94) 0%, rgba(8,12,20,0.6) 60%, rgba(8,12,20,0) 100%)',
        }}
      >
        <div
          style={{
            fontSize: 'clamp(18px, 5.4vw, 23px)',
            fontWeight: 900,
            color: 'var(--ink)',
            letterSpacing: '0.03em',
          }}
        >
          まもなく はじまります
        </div>
        <div style={{ marginTop: 8, fontSize: 13.5, color: 'rgba(226,238,248,0.78)' }}>
          大きなスクリーンを見てください。
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 20,
          padding: '26px 14px 12px',
          pointerEvents: 'none',
          background:
            'linear-gradient(180deg, rgba(8,12,20,0) 0%, rgba(8,12,20,0.72) 45%, rgba(8,12,20,0.92) 100%)',
        }}
      >
        <HowToPlay variant="compact" />
      </div>
    </>
  );
}

export interface PhoneShellProps {
  roomId: string;
}

export function PhoneShell({ roomId }: PhoneShellProps) {
  const api = useControllerSocket(roomId);
  const {
    joinPhase,
    connected,
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
  } = api;

  // The hook returns a fresh object every render; a ref keeps the callbacks below
  // stable without making them depend on it.
  const apiRef = useRef(api);
  apiRef.current = api;

  /**
   * iOS grants motion access only from inside a genuine user gesture, and the
   * same is true of the audio context. Both are therefore started synchronously
   * from the tap: no await, no timeout, no effect.
   */
  /** A synchronous failure inside the tap handler, shown instead of silence. */
  const [joinError, setJoinError] = useState<string | null>(null);

  const handleJoin = useCallback(() => {
    setJoinError(null);
    // Sound is a courtesy; joining is the product. An AudioContext that refuses
    // to start — an old iOS with only webkitAudioContext, a device in a state
    // that rejects it — must never be able to take the tap down with it.
    try {
      void audio.resume();
    } catch {
      /* keep going: the player can hear nothing and still play */
    }
    try {
      void apiRef.current.join();
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const getTilt = useCallback(() => apiRef.current.adapter?.state.tiltX ?? 0, []);

  /** Streams the touch-steer vector into the adapter (0,0 = finger up). */
  const setSteer = useCallback((x: number, y: number) => {
    apiRef.current.adapter?.setTouchVector(x, y);
  }, []);

  // --- server clock offset, so the round timer ticks smoothly --------------
  // room:state arrives about once a second; the phase payload carries absolute
  // server timestamps, so we interpolate locally between them rather than
  // showing a clock that jumps.
  const offsetRef = useRef(0);
  useEffect(() => {
    if (room) offsetRef.current = room.serverTime - Date.now();
  }, [room]);

  const [, bump] = useState(0);
  useEffect(() => {
    if (joinPhase !== 'joined') return;
    const id = setInterval(() => bump((n) => (n + 1) % 1024), 250);
    return () => clearInterval(id);
  }, [joinPhase]);

  // --- feedback the player can feel without looking (spec §88) -------------
  const { onCapture, onBreak } = api;
  useEffect(() => {
    if (joinPhase !== 'joined') return;
    const offCapture = onCapture(() => {
      audio.play('bowlDrop', { volume: 0.55 });
      vibrate(18);
    });
    const offBreak = onBreak(() => {
      audio.play('poiBreak', { volume: 0.5 });
      vibrate([26, 60, 26]);
    });
    return () => {
      offCapture();
      offBreak();
    };
  }, [joinPhase, onCapture, onBreak]);

  // --- derived state -------------------------------------------------------
  const state: RoomState = phase?.state ?? room?.state ?? 'WAITING';
  const fish = bowl ? bowl.capturedFish : EMPTY_FISH;
  const me = room?.players.find((p) => p.id === playerId) ?? null;
  const score = bowl?.score ?? me?.score ?? 0;
  const fishCount = bowl ? bowl.capturedFish.length : me?.fishCount ?? 0;

  const roundSeconds = room?.settings.durationSeconds ?? GAME.defaultDurationSeconds;
  const endsAt = phase?.endsAt ?? room?.phaseEndsAt ?? null;
  const liveRemaining =
    endsAt !== null
      ? Math.max(0, (endsAt - (Date.now() + offsetRef.current)) / 1000)
      : phase?.timeRemaining ?? 0;
  // Outside PLAYING the clock shows the length of the round rather than a zero
  // that would blink red at a player who has not started yet.
  const clockSeconds = state === 'PLAYING' ? liveRemaining : roundSeconds;

  const finalResult = result ?? room?.result ?? null;
  const ranked = finalResult?.rankings.find((r) => r.id === playerId) ?? null;
  // Someone who scanned the QR code during the last thirty seconds of a round is
  // not in the rankings and has no result to celebrate: they get the bowl and the
  // 「次のゲームに参加します」 banner instead of an empty scoreboard (spec §85).
  const playedThisRound = finalResult === null || ranked !== null;
  // Before the result payload lands, place the player against the public scores.
  const rank = ranked
    ? ranked.rank
    : 1 + (room?.players.filter((p) => p.score > score).length ?? 0);

  const sensorProblem =
    status.permission === 'denied' ||
    status.permission === 'unsupported' ||
    !status.supported ||
    (error !== null && /センサー|モーション|許可/.test(error));

  // --- body ----------------------------------------------------------------
  let body: ReactNode;

  if (joinPhase === 'idle') {
    body = <JoinGate roomId={roomId} join={handleJoin} />;
  } else if (joinPhase === 'requesting' || joinPhase === 'joining') {
    body = <Preparing joining={joinPhase === 'joining'} />;
  } else if (joinPhase === 'error' || joinError) {
    body = (
      <ErrorPane
        message={
          joinError
            ? `参加処理でエラーが起きました。\n\n${joinError}`
            : (error ?? '参加できませんでした。もう一度お試しください。')
        }
        sensorProblem={sensorProblem && !joinError}
        onRetry={handleJoin}
      />
    );
  } else if (state === 'RESULT' && playedThisRound) {
    body = (
      // The round is over, so letting a small phone scroll a long result costs
      // nobody anything. Nothing here affects play.
      <div
        style={{
          flex: 1,
          minHeight: 0,
          height: '100%',
          overflowY: 'auto',
          touchAction: 'pan-y',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        <PhoneResult
          playerNumber={playerNumber}
          color={color}
          score={ranked?.score ?? score}
          fishCount={ranked?.fishCount ?? fishCount}
          capturedFish={fish}
          rank={rank}
        />
      </div>
    );
  } else {
    body = (
      <>
        <StatusBar
          playerNumber={playerNumber}
          color={color}
          score={score}
          fishCount={fishCount}
          connected={connected}
          latencyMs={latencyMs}
          timeRemaining={clockSeconds}
        />

        {/* The bowl is the largest thing on the phone (spec §86). */}
        <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
          <TouchSteer setVector={setSteer}>
            <TiltedBowl capturedFish={fish} getTilt={getTilt} />
          </TouchSteer>

          {spectating || state === 'RESULT' ? (
            <SpectateBanner />
          ) : state === 'CALIBRATION' ? (
            <CalibrationOverlay
              count={phase?.count ?? null}
              timeRemaining={phase?.timeRemaining ?? GAME.calibrationSeconds}
              color={color}
            />
          ) : state === 'WAITING' ? (
            <WaitingPane />
          ) : null}
        </div>

        <div style={BOTTOM}>
          <PoiStatus
            durability={bowl?.poiDurability ?? POI.maxDurability}
            wetness={bowl?.poiWetness ?? 0}
            state={toPoiState(bowl?.poiState)}
            respawnIn={bowl?.respawnIn ?? 0}
          />
          <div style={QUIET_LINE}>大きなスクリーンを見て あそぼう</div>
          <ConnectionBadge connected={connected} latencyMs={latencyMs} status={status} />
        </div>
      </>
    );
  }

  // 'controller-surface' kills touch-action, selection and callouts — correct
  // once the phone IS the poi (§23), but the join screen still needs to behave
  // like a normal page: it has the only tap in the piece, and some iOS versions
  // are unreliable about delivering clicks under an ancestor with
  // touch-action: none. The no-touch rule starts when the poi does.
  const playing = joinPhase === 'joined';

  return (
    <div
      className={playing ? 'controller-surface' : undefined}
      style={playing ? ROOT : { ...ROOT, position: 'fixed', inset: 0 }}
    >
      {body}
    </div>
  );
}
