'use client';

/**
 * The DOM overlay for the giant screen (spec §99, §100, §101).
 *
 * Everything in here hugs an edge. The middle of the frame belongs to the tank, which
 * has to read as 85–90% of the picture; the only things ever allowed to cross the centre
 * are the phase beats and the lobby / result panels, and those are translucent and
 * short-lived.
 *
 * Layout, clockwise from the top left:
 *
 *   top-left      title mark + room id
 *   top-centre    TimeBar (PLAYING only)
 *   top-right     connection state
 *   right edge    ScoreBoard, then the CaptureFeed rising underneath it
 *   bottom-left   compact QR so latecomers can queue for the next round
 *   centre        WaitingView / PhaseOverlay / ResultView, by room state
 */

import { useEffect, useMemo, useRef } from 'react';

import { CaptureFeed } from '@/components/screen/CaptureFeed';
import { PhaseOverlay } from '@/components/screen/PhaseOverlay';
import { ResultView } from '@/components/screen/ResultView';
import { ScoreBoard } from '@/components/screen/ScoreBoard';
import { TimeBar } from '@/components/screen/TimeBar';
import { WaitingView } from '@/components/screen/WaitingView';
import { QRPanel } from '@/components/QRPanel';
import { GAME } from '@/game/core/constants';
import type { ScreenSocketApi } from '@/network/socket/useScreenSocket';

// ---------------------------------------------------------------------------
// Server clock
// ---------------------------------------------------------------------------

export interface ServerClock {
  /** Current time on the SERVER's clock, in ms. */
  now(): number;
  /** Estimated offset that is being added to the local clock. */
  offsetMs(): number;
  /** Delay of the most recent room packet above the best case seen, in ms. */
  latencyMs(): number;
}

/**
 * Estimates the server clock from the 'serverTime' stamped on every room packet.
 *
 * A packet stamped at T arrives at local time L, so (T - L) understates the true offset
 * by exactly the one-way delay. The MAXIMUM of that difference therefore comes from the
 * fastest packet seen, which is the best available estimate of the offset; the gap
 * between the latest sample and that maximum is the extra delay this packet suffered.
 *
 * The maximum decays very slowly so genuine clock drift over a long evening is tracked
 * instead of being locked to whatever the first lucky packet said.
 */
export function useServerClock(serverTime: number | undefined): ServerClock {
  const state = useRef({ best: Number.NEGATIVE_INFINITY, latest: 0, lastAt: 0 });

  useEffect(() => {
    if (serverTime === undefined || !Number.isFinite(serverTime)) return;
    const localNow = Date.now();
    const sample = serverTime - localNow;
    const s = state.current;

    if (s.best === Number.NEGATIVE_INFINITY) {
      s.best = sample;
    } else {
      // 0.4 ms per second of decay: invisible over a round, enough over an evening.
      const elapsed = s.lastAt > 0 ? Math.max(0, (localNow - s.lastAt) / 1000) : 0;
      s.best = Math.max(sample, s.best - elapsed * 0.4);
    }
    s.latest = sample;
    s.lastAt = localNow;
  }, [serverTime]);

  return useMemo<ServerClock>(
    () => ({
      now: () => {
        const s = state.current;
        return Date.now() + (s.best === Number.NEGATIVE_INFINITY ? 0 : s.best);
      },
      offsetMs: () => {
        const s = state.current;
        return s.best === Number.NEGATIVE_INFINITY ? 0 : s.best;
      },
      latencyMs: () => {
        const s = state.current;
        if (s.best === Number.NEGATIVE_INFINITY) return 0;
        return Math.max(0, s.best - s.latest);
      },
    }),
    [],
  );
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

export interface ScreenHudProps {
  api: ScreenSocketApi;
  roomId: string;
  joinUrl: string;
  clock: ServerClock;
}

const EDGE = 'clamp(16px, 1.9vw, 40px)';

function ConnectionPip({ connected, players }: { connected: boolean; players: number }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        fontSize: 12,
        color: 'var(--ink-dim)',
        letterSpacing: '0.14em',
      }}
    >
      <span className="tabular">{players} 台</span>
      <span
        style={{
          width: 9,
          height: 9,
          borderRadius: '50%',
          background: connected ? '#5fd08a' : '#d8735f',
          boxShadow: connected ? '0 0 12px rgba(95,208,138,0.8)' : '0 0 12px rgba(216,115,95,0.8)',
          animation: connected ? 'none' : 'kingyo-pulse 1.3s ease-in-out infinite',
        }}
      />
    </div>
  );
}

export function ScreenHud({ api, roomId, joinUrl, clock }: ScreenHudProps) {
  // Keyboard shortcut for the operator: the projector machine has a keyboard,
  // and reaching for a mouse mid-show is worse than a key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.code !== 'Space' && e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
      const state = api.room?.state;
      if (state !== 'WAITING' && state !== 'RESULT') return;
      e.preventDefault();
      api.send({ type: 'START' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [api]);

  const { room, phase, connected, onCapture } = api;

  const state = phase?.state ?? room?.state ?? 'WAITING';
  const players = room?.players ?? [];
  const settings = room?.settings;

  // The lobby and the result panel each own the frame on their own; the edge furniture
  // steps aside for them rather than colliding with a centred panel.
  const inRound = state === 'CALIBRATION' || state === 'COUNTDOWN' || state === 'PLAYING';
  const showScores = inRound;
  const showTime = state === 'PLAYING';
  const showCornerQr = inRound;

  const serverNow = useMemo(() => () => clock.now(), [clock]);

  return (
    <div className="screen-overlay">
      {/* ------------------------------------------------------------ top left */}
      <div
        style={{
          position: 'absolute',
          top: EDGE,
          left: EDGE,
          display: 'flex',
          alignItems: 'baseline',
          gap: 14,
          opacity: state === 'WAITING' ? 0 : 0.92,
          transition: 'opacity 500ms ease',
        }}
      >
        <span
          className="jp-title"
          style={{
            fontSize: 'clamp(15px, 1.3vw, 24px)',
            color: 'var(--lantern)',
            textShadow: '0 2px 12px rgba(0,0,0,0.8)',
          }}
        >
          巨大デジタル金魚すくい
        </span>
        <span
          className="tabular"
          style={{ fontSize: 11, letterSpacing: '0.24em', color: 'var(--ink-dim)' }}
        >
          {roomId}
        </span>
      </div>

      {/* ---------------------------------------------------------- top centre */}
      <div
        style={{
          position: 'absolute',
          top: EDGE,
          left: '50%',
          transform: 'translateX(-50%)',
          opacity: showTime ? 1 : 0,
          transition: 'opacity 380ms ease',
        }}
      >
        {showTime ? (
          <TimeBar
            phase={phase}
            serverNow={serverNow}
            durationSeconds={settings?.durationSeconds ?? GAME.defaultDurationSeconds}
          />
        ) : null}
      </div>

      {/* ----------------------------------------------------------- top right */}
      <div style={{ position: 'absolute', top: EDGE, right: EDGE }}>
        <ConnectionPip connected={connected} players={players.filter((p) => p.connected).length} />
      </div>

      {/* ---------------------------------------------------------- right edge */}
      <div
        style={{
          position: 'absolute',
          top: `calc(${EDGE} + 34px)`,
          right: EDGE,
          bottom: EDGE,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 14,
          opacity: showScores ? 1 : 0,
          transition: 'opacity 420ms ease',
        }}
      >
        {showScores ? (
          <>
            <ScoreBoard players={players} dim={state !== 'PLAYING'} />
            <CaptureFeed onCapture={onCapture} />
          </>
        ) : null}
      </div>

      {/* -------------------------------------------------------- bottom left */}
      <div
        style={{
          position: 'absolute',
          left: EDGE,
          bottom: EDGE,
          display: 'flex',
          alignItems: 'flex-end',
          gap: 14,
          opacity: showCornerQr ? 0.9 : 0,
          transition: 'opacity 500ms ease',
        }}
      >
        {showCornerQr ? (
          <>
            <QRPanel url={joinUrl} size={130} />
            <div
              style={{
                paddingBottom: 26,
                fontSize: 12,
                lineHeight: 1.7,
                color: 'var(--ink-dim)',
                maxWidth: 190,
              }}
            >
              <span style={{ color: 'var(--lantern)' }}>あとから参加</span>
              <br />
              つぎのゲームから入れます
            </div>
          </>
        ) : null}
      </div>

      {/* -------------------------------------------------------------- centre */}
      {state === 'WAITING' ? (
        <WaitingView
          joinUrl={joinUrl}
          players={players}
          maxPlayers={settings?.maxPlayers ?? GAME.maxPlayers}
          onStart={() => api.send({ type: 'START' })}
          onClearPlayers={() => api.send({ type: 'CLEAR_PLAYERS' })}
        />
      ) : null}

      {state === 'RESULT' ? (
        <ResultView
          result={room?.result ?? null}
          serverNow={serverNow}
          endsAt={phase?.endsAt ?? room?.phaseEndsAt ?? null}
        />
      ) : null}

      <PhaseOverlay phase={phase} serverNow={serverNow} />
    </div>
  );
}

export default ScreenHud;
