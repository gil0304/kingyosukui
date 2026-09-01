'use client';

/**
 * Remaining time, hugging the top edge (spec §101).
 *
 * The server only pushes a phase packet on change plus a slow heartbeat, so the number
 * here is derived from 'phase.endsAt' against the local clock (corrected by the measured
 * server offset). That keeps the bar perfectly smooth between packets and still snaps to
 * the server's truth the moment a new one lands.
 *
 * Below ten seconds the whole strip shifts to the crimson end and breathes — slowly, so
 * it raises the pulse without turning into a strobe on a five-metre projection.
 */

import { useEffect, useRef, useState } from 'react';

import { GAME } from '@/game/core/constants';
import { clamp01 } from '@/game/core/math';
import type { PhasePayload } from '@/network/protocol/events';

export interface TimeBarProps {
  phase: PhasePayload | null;
  /** Returns the current server-clock time in ms. */
  serverNow: () => number;
  /** Round length, used for the bar's full width. */
  durationSeconds?: number;
}

const URGENT_SECONDS = 10;

const formatClock = (secondsLeft: number): string => {
  const s = Math.max(0, Math.ceil(secondsLeft));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
};

export function TimeBar({ phase, serverNow, durationSeconds }: TimeBarProps) {
  const fillRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [displaySeconds, setDisplaySeconds] = useState(() =>
    Math.ceil(phase?.timeRemaining ?? durationSeconds ?? GAME.defaultDurationSeconds),
  );
  const [urgent, setUrgent] = useState(false);

  const endsAt = phase?.endsAt ?? null;
  const fallback = phase?.timeRemaining ?? 0;
  const total = durationSeconds ?? GAME.defaultDurationSeconds;

  // Held in refs so the animation frame never closes over stale props.
  const stateRef = useRef({ endsAt, fallback, total, serverNow });
  stateRef.current = { endsAt, fallback, total, serverNow };

  useEffect(() => {
    let raf = 0;
    let lastWhole = -1;
    let lastUrgent: boolean | null = null;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const s = stateRef.current;
      const left =
        s.endsAt === null ? s.fallback : Math.max(0, (s.endsAt - s.serverNow()) / 1000);

      const fraction = clamp01(s.total > 0 ? left / s.total : 0);
      const fill = fillRef.current;
      if (fill) fill.style.transform = `scaleX(${fraction.toFixed(4)})`;

      const isUrgent = left <= URGENT_SECONDS;
      const wrap = wrapRef.current;
      if (wrap && isUrgent) {
        // A slow 1.6s breath. Opacity only: moving the strip would fight the tank.
        const pulse = 0.72 + 0.28 * (0.5 + 0.5 * Math.sin((performance.now() / 1000) * 3.9));
        wrap.style.opacity = pulse.toFixed(3);
      } else if (wrap) {
        wrap.style.opacity = '1';
      }

      const whole = Math.ceil(left);
      if (whole !== lastWhole) {
        lastWhole = whole;
        setDisplaySeconds(whole);
      }
      if (isUrgent !== lastUrgent) {
        lastUrgent = isUrgent;
        setUrgent(isUrgent);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      ref={wrapRef}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        minWidth: 320,
        transition: 'opacity 120ms linear',
      }}
    >
      <div
        className="tabular"
        style={{
          fontSize: 'clamp(30px, 3.4vw, 60px)',
          lineHeight: 1,
          fontWeight: 700,
          color: urgent ? '#ff7a63' : 'var(--ink)',
          textShadow: urgent
            ? '0 0 26px rgba(200,53,42,0.75), 0 2px 6px rgba(0,0,0,0.8)'
            : '0 2px 10px rgba(0,0,0,0.85)',
          letterSpacing: '0.02em',
          transition: 'color 220ms linear',
        }}
      >
        {formatClock(displaySeconds)}
      </div>

      <div
        style={{
          width: 'min(38vw, 720px)',
          height: 7,
          borderRadius: 4,
          background: 'rgba(255,255,255,0.10)',
          boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.45)',
          overflow: 'hidden',
        }}
      >
        <div
          ref={fillRef}
          style={{
            width: '100%',
            height: '100%',
            transformOrigin: 'left center',
            transform: 'scaleX(1)',
            borderRadius: 4,
            background: urgent
              ? 'linear-gradient(90deg, #ff5a3c, #c8352a)'
              : 'linear-gradient(90deg, #ffd07a, #ffb64d 55%, #e2612b)',
            boxShadow: `0 0 18px ${urgent ? 'rgba(200,53,42,0.75)' : 'rgba(255,182,77,0.55)'}`,
            transition: 'background 240ms linear',
          }}
        />
      </div>

      <div
        style={{
          fontSize: 11,
          letterSpacing: '0.34em',
          color: urgent ? 'rgba(255,140,120,0.9)' : 'var(--ink-dim)',
        }}
      >
        {urgent ? 'のこりわずか' : 'TIME'}
      </div>
    </div>
  );
}

export default TimeBar;
