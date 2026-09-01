'use client';

/**
 * The phone's play-time HUD (spec §22, §88).
 *
 * Shows exactly four things: which player you are, your score, how many fish
 * you have scooped, and whether you are still connected — plus the clock.
 *
 * It contains NO control affordance of any kind: no virtual stick, no d-pad, no
 * scoop button, no tap-to-catch, no swipe, no slider (spec §23). Nothing here
 * is a button, nothing here has an onClick, and touching it changes nothing.
 * The phone *is* the poi; the screen is only a readout.
 *
 * Legibility target: read at arm's length, outdoors, at night, in one glance.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { clamp01, lerp } from '@/game/core/math';
import { formatScore } from '@/game/scoring/scoring';

export interface StatusBarProps {
  playerNumber: number;
  /** The player's accent colour ('PLAYER_COLORS'). */
  color: string;
  score: number;
  fishCount: number;
  connected: boolean;
  latencyMs: number;
  /** Seconds left in the round. */
  timeRemaining: number;
}

/**
 * Ease a displayed number toward a target (spec §92: the score counts up when a
 * fish lands in the bowl). Shared with 'PhoneResult', which passes 'initial = 0'
 * so the final score climbs from nothing once, at the end of the round.
 */
export function useCountUp(target: number, seconds = 0.7, initial = target): number {
  const [shown, setShown] = useState(initial);
  const shownRef = useRef(initial);
  const fromRef = useRef(initial);

  useEffect(() => {
    if (target === shownRef.current) return;
    fromRef.current = shownRef.current;
    let start = 0;
    let raf = 0;

    const step = (ms: number) => {
      if (start === 0) start = ms;
      const p = clamp01((ms - start) / (seconds * 1000));
      // Cubic ease-out: fast enough to feel like a reward, slow enough to read.
      const e = 1 - (1 - p) * (1 - p) * (1 - p);
      const v = Math.round(lerp(fromRef.current, target, e));
      shownRef.current = v;
      setShown(v);
      if (p < 1) raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, seconds]);

  return shown;
}

const LABEL: CSSProperties = {
  fontSize: 11,
  letterSpacing: '0.16em',
  color: 'rgba(198,216,232,0.72)',
  fontWeight: 700,
  lineHeight: 1,
};

const NUMERIC: CSSProperties = {
  fontVariantNumeric: 'tabular-nums',
  fontFeatureSettings: '"tnum"',
};

const latencyColor = (ms: number): string =>
  ms < 70 ? '#4bd47a' : ms < 150 ? '#e8c33c' : '#e0483a';

export function StatusBar({
  playerNumber,
  color,
  score,
  fishCount,
  connected,
  latencyMs,
  timeRemaining,
}: StatusBarProps) {
  const shownScore = useCountUp(score);
  const secs = Math.max(0, Math.ceil(timeRemaining));
  const urgent = secs <= 10;

  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 'calc(env(safe-area-inset-top, 0px) + 12px) calc(env(safe-area-inset-right, 0px) + 14px) 12px calc(env(safe-area-inset-left, 0px) + 14px)',
        background: 'linear-gradient(180deg, rgba(7,13,22,0.97) 0%, rgba(7,13,22,0.86) 100%)',
        borderBottom: `2px solid ${color}`,
        color: '#f2f7fb',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        fontFamily:
          '"Hiragino Kaku Gothic ProN", "Noto Sans JP", system-ui, -apple-system, sans-serif',
      }}
    >
      <style>{`@keyframes kgs-sb-urgent{0%,100%{opacity:1}50%{opacity:0.45}}`}</style>

      {/* --- identity / clock / link ------------------------------------- */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 6,
            padding: '6px 12px 7px',
            borderRadius: 12,
            background: color,
            boxShadow: `0 0 18px ${color}66`,
            color: '#0b1119',
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.12em' }}>PLAYER</span>
          <span style={{ ...NUMERIC, fontSize: 24, fontWeight: 900, lineHeight: 1 }}>
            {playerNumber}
          </span>
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ textAlign: 'right' }}>
          <div style={{ ...LABEL, marginBottom: 4 }}>のこり</div>
          <div
            style={{
              ...NUMERIC,
              fontSize: 32,
              fontWeight: 900,
              lineHeight: 1,
              color: urgent ? '#ff6b52' : '#f2f7fb',
              animation: urgent ? 'kgs-sb-urgent 0.7s ease-in-out infinite' : undefined,
            }}
          >
            {secs}
            <span style={{ fontSize: 14, fontWeight: 700, marginLeft: 3 }}>秒</span>
          </div>
        </div>
      </div>

      {/* --- score / catch count / connection ------------------------------ */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...LABEL, marginBottom: 5 }}>スコア</div>
          <div
            style={{
              ...NUMERIC,
              fontSize: 40,
              fontWeight: 900,
              lineHeight: 0.95,
              letterSpacing: '-0.01em',
              textShadow: `0 0 22px ${color}55`,
            }}
          >
            {formatScore(shownScore)}
          </div>
        </div>

        <div style={{ textAlign: 'right' }}>
          <div style={{ ...LABEL, marginBottom: 5 }}>すくった</div>
          <div style={{ ...NUMERIC, fontSize: 28, fontWeight: 900, lineHeight: 1 }}>
            {fishCount}
            <span style={{ fontSize: 14, fontWeight: 700, marginLeft: 2 }}>匹</span>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            paddingBottom: 3,
            minWidth: 74,
            justifyContent: 'flex-end',
          }}
        >
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: 9,
              background: connected ? latencyColor(latencyMs) : '#e0483a',
              boxShadow: connected ? `0 0 9px ${latencyColor(latencyMs)}` : 'none',
              animation: connected ? undefined : 'kgs-sb-urgent 0.9s ease-in-out infinite',
            }}
          />
          <span
            style={{
              ...NUMERIC,
              fontSize: 12,
              fontWeight: 700,
              color: connected ? 'rgba(198,216,232,0.8)' : '#ff8a76',
            }}
          >
            {connected ? `${Math.round(latencyMs)}ms` : '切断'}
          </span>
        </div>
      </div>
    </div>
  );
}
