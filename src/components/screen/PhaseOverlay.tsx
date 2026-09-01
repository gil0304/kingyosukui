'use client';

/**
 * The centre beats: calibration, the countdown, and TIME UP (spec §28, §98, §102).
 *
 * Everything here is derived from the authoritative phase — 'endsAt' against the
 * server-corrected clock, with 'count' as the fallback when the phase is open-ended.
 * There is no independent local timer anywhere in this file, so a screen that was
 * backgrounded, or one that connected late, lands on exactly the number every phone in
 * the room is already showing.
 *
 * This is the one place UI is allowed in the middle of the tank, and only for a few
 * seconds at a time.
 */

import { useEffect, useRef, useState } from 'react';

import { audio } from '@/audio/AudioEngine';
import type { PhasePayload } from '@/network/protocol/events';
import type { RoomState } from '@/types';

/** How long TIME UP holds the centre before the ranking takes over (spec §102). */
export const TIME_UP_SECONDS = 2.4;

/** The last stretch of COUNTDOWN, where the numbers give way to START. */
const START_WINDOW = 0.55;

export interface PhaseOverlayProps {
  phase: PhasePayload | null;
  /** Current server-clock time in ms. */
  serverNow: () => number;
}

type Beat =
  | { kind: 'none' }
  | { kind: 'calibration'; count: number }
  | { kind: 'countdown'; count: number }
  | { kind: 'start' }
  | { kind: 'timeup' };

const beatId = (b: Beat): string => (b.kind === 'countdown' || b.kind === 'calibration' ? `${b.kind}:${b.count}` : b.kind);

const KEYFRAMES = `
/* Each number pops in and then simply holds: the next number replaces it, so a fade-out
   here would leave a hole in the middle of the screen between beats. */
@keyframes kingyo-count {
  0%   { opacity: 0; transform: scale(1.75); }
  26%  { opacity: 1; transform: scale(0.97); }
  46%  { transform: scale(1.02); }
  100% { opacity: 1; transform: scale(1); }
}
@keyframes kingyo-start {
  0%   { opacity: 0; transform: scale(0.55); }
  38%  { opacity: 1; transform: scale(1.1); }
  60%  { transform: scale(1); }
  100% { opacity: 1; transform: scale(1); }
}
@keyframes kingyo-timeup {
  0%   { opacity: 0; transform: scale(1.5); }
  16%  { opacity: 1; transform: scale(1); }
  80%  { opacity: 1; transform: scale(1); }
  100% { opacity: 0; transform: scale(1.06); }
}
@media (prefers-reduced-motion: reduce) {
  @keyframes kingyo-count { 0% { opacity: 0; } 26% { opacity: 1; } 100% { opacity: 1; } }
  @keyframes kingyo-start { 0% { opacity: 0; } 38% { opacity: 1; } 100% { opacity: 1; } }
  @keyframes kingyo-timeup { 0% { opacity: 0; } 16% { opacity: 1; } 80% { opacity: 1; } 100% { opacity: 0; } }
}
`;

export function PhaseOverlay({ phase, serverNow }: PhaseOverlayProps) {
  const [beat, setBeat] = useState<Beat>({ kind: 'none' });

  const state: RoomState | null = phase?.state ?? null;

  // The moment PLAYING gave way to RESULT — TIME UP owns the centre until it expires.
  const timeUpUntil = useRef(0);
  const prevState = useRef<RoomState | null>(null);

  const liveRef = useRef({ phase, serverNow });
  liveRef.current = { phase, serverNow };

  useEffect(() => {
    if (prevState.current === 'PLAYING' && state === 'RESULT') {
      timeUpUntil.current = Date.now() + TIME_UP_SECONDS * 1000;
      audio.play('timeUp', { volume: 0.95 });
    }
    prevState.current = state;
  }, [state]);

  useEffect(() => {
    let raf = 0;
    let spokenId = '';

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const { phase: p, serverNow: now } = liveRef.current;

      let next: Beat = { kind: 'none' };

      if (Date.now() < timeUpUntil.current) {
        next = { kind: 'timeup' };
      } else if (p && (p.state === 'CALIBRATION' || p.state === 'COUNTDOWN')) {
        const left =
          p.endsAt === null ? p.timeRemaining : Math.max(0, (p.endsAt - now()) / 1000);

        if (p.state === 'COUNTDOWN' && left <= START_WINDOW) {
          next = { kind: 'start' };
        } else {
          // Same rule the server's lifecycle uses, so both ends always agree.
          const count = Math.max(1, Math.min(3, Math.ceil(left)));
          next = p.state === 'CALIBRATION' ? { kind: 'calibration', count } : { kind: 'countdown', count };
        }
      }

      const id = beatId(next);
      if (id !== spokenId) {
        spokenId = id;
        setBeat(next);
        if (next.kind === 'countdown' || next.kind === 'calibration') {
          audio.play('countdown', { volume: next.kind === 'countdown' ? 0.8 : 0.45 });
        } else if (next.kind === 'start') {
          audio.play('start', { volume: 1 });
        }
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (beat.kind === 'none') return null;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 18,
        pointerEvents: 'none',
        textAlign: 'center',
      }}
    >
      <style>{KEYFRAMES}</style>

      {beat.kind === 'calibration' ? (
        <>
          <div
            className="jp-title"
            style={{
              fontSize: 'clamp(26px, 3.2vw, 54px)',
              color: 'var(--ink)',
              textShadow: '0 4px 26px rgba(0,0,0,0.9)',
            }}
          >
            スマホを自然に構えてください
          </div>
          <div
            style={{
              fontSize: 'clamp(13px, 1.1vw, 19px)',
              color: 'var(--ink-dim)',
              letterSpacing: '0.14em',
            }}
          >
            そのままの姿勢が「まんなか」になります
          </div>
          <div
            key={beat.count}
            className="tabular"
            style={{
              fontSize: 'clamp(120px, 15vw, 260px)',
              lineHeight: 0.9,
              fontWeight: 700,
              color: 'var(--lantern)',
              textShadow: '0 0 70px rgba(255,182,77,0.55), 0 6px 30px rgba(0,0,0,0.85)',
              animation: 'kingyo-count 620ms ease-out both',
            }}
          >
            {beat.count}
          </div>
        </>
      ) : null}

      {beat.kind === 'countdown' ? (
        <div
          key={beat.count}
          className="tabular"
          style={{
            fontSize: 'clamp(150px, 21vw, 380px)',
            lineHeight: 0.86,
            fontWeight: 700,
            color: 'var(--ink)',
            textShadow: '0 0 90px rgba(255,182,77,0.6), 0 8px 40px rgba(0,0,0,0.9)',
            animation: 'kingyo-count 620ms cubic-bezier(0.16, 0.9, 0.3, 1) both',
          }}
        >
          {beat.count}
        </div>
      ) : null}

      {beat.kind === 'start' ? (
        <div
          className="tabular"
          style={{
            fontSize: 'clamp(90px, 13vw, 240px)',
            lineHeight: 0.9,
            fontWeight: 700,
            letterSpacing: '0.06em',
            color: 'var(--lantern)',
            textShadow: '0 0 90px rgba(255,182,77,0.85), 0 8px 40px rgba(0,0,0,0.9)',
            animation: 'kingyo-start 420ms cubic-bezier(0.18, 1.1, 0.4, 1) both',
          }}
        >
          START!
        </div>
      ) : null}

      {beat.kind === 'timeup' ? (
        <>
          <div
            className="tabular"
            style={{
              fontSize: 'clamp(96px, 14vw, 260px)',
              lineHeight: 0.9,
              fontWeight: 700,
              letterSpacing: '0.05em',
              color: '#ffd489',
              textShadow: '0 0 100px rgba(226,97,43,0.8), 0 8px 40px rgba(0,0,0,0.9)',
              animation: `kingyo-timeup ${TIME_UP_SECONDS}s ease-out both`,
            }}
          >
            TIME UP!
          </div>
          <div
            className="jp-title"
            style={{
              fontSize: 'clamp(18px, 1.8vw, 32px)',
              color: 'var(--ink-dim)',
              animation: `kingyo-timeup ${TIME_UP_SECONDS}s ease-out both`,
            }}
          >
            ポイを上げてください
          </div>
        </>
      ) : null}
    </div>
  );
}

export default PhaseOverlay;
