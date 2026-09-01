'use client';

/**
 * Calibration, as seen from the player's hand (spec §28, §29).
 *
 * The giant screen says 「スマホを自然に構えてください」 and counts 3, 2, 1. The
 * phone says exactly the same thing, at the same time, so that a player who is
 * looking at their hand and a player who is looking at the wall are never out of
 * step. The number comes straight from the server phase payload for that reason:
 * we never run our own timer here.
 *
 * There is deliberately NO button (spec §29). Calibration finishes by itself —
 * the controller hook receives 'controller:calibrate', averages the neutral pose
 * for the length of the countdown, and reports back. Whatever posture the player
 * happens to be holding when the count reaches zero becomes the centre of the
 * tank, which is why the illustration below is completely still: any animation
 * here would invite the player to move exactly when they must not.
 */

import type { CSSProperties } from 'react';

export interface CalibrationOverlayProps {
  /** Integer countdown mirrored from the giant screen; null before it starts. */
  count: number | null;
  /** Seconds left in the calibration phase — the fallback when count is null. */
  timeRemaining: number;
  /** The player's accent colour, so the phone matches their poi. */
  color?: string;
}

const SKIN = 'rgba(232,201,166,0.88)';

/** The neutral pose: held comfortably, tipped a little forward, perfectly still. */
function NeutralPose({ color }: { color: string }) {
  return (
    <svg width="132" height="113" viewBox="0 0 140 120" aria-hidden="true">
      <defs>
        <radialGradient id="kgs-cal-glow" cx="50%" cy="48%" r="50%">
          <stop offset="0%" stopColor={color} stopOpacity="0.32" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </radialGradient>
      </defs>

      <ellipse cx="70" cy="58" rx="62" ry="56" fill="url(#kgs-cal-glow)" />

      {/* Straight up: the reference the tilt is measured against. */}
      <path
        d="M70 12 V106"
        stroke="rgba(244,239,228,0.2)"
        strokeWidth="2"
        strokeDasharray="3 5"
        strokeLinecap="round"
      />

      <g transform="translate(70 58) rotate(-13)">
        {/* Hands, resting. */}
        <rect x="-30" y="14" width="13" height="26" rx="6.5" fill={SKIN} />
        <rect x="17" y="14" width="13" height="26" rx="6.5" fill={SKIN} />

        <rect
          x="-22"
          y="-34"
          width="44"
          height="68"
          rx="9"
          fill="rgba(10,14,26,0.95)"
          stroke="var(--ink)"
          strokeWidth="2.8"
        />
        <rect x="-16" y="-27" width="32" height="48" rx="4" fill="var(--water)" opacity="0.3" />
        <rect x="-7" y="25" width="14" height="3" rx="1.5" fill="rgba(244,239,228,0.5)" />
      </g>
    </svg>
  );
}

export function CalibrationOverlay({
  count,
  timeRemaining,
  color = 'var(--lantern)',
}: CalibrationOverlayProps) {
  const raw = count !== null ? count : Math.ceil(timeRemaining);
  const shown = Math.max(1, Math.min(9, Number.isFinite(raw) ? raw : 1));

  const label: CSSProperties = {
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: '0.28em',
    color: 'rgba(198,216,232,0.66)',
  };

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 30,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: '16px 20px',
        textAlign: 'center',
        background:
          'radial-gradient(120% 80% at 50% 40%, rgba(9,14,24,0.9) 0%, rgba(6,10,18,0.97) 70%)',
        fontFamily: 'var(--font-ui)',
        overflow: 'hidden',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        pointerEvents: 'none',
      }}
    >
      <style>
        {'@keyframes kgs-cal-pop{0%{transform:scale(0.72);opacity:0}52%{transform:scale(1.1);opacity:1}100%{transform:scale(1);opacity:1}}'}
      </style>

      <div style={{ ...label, flexShrink: 0 }}>じゅんび</div>

      <div
        style={{
          flexShrink: 0,
          fontSize: 'clamp(19px, 5.8vw, 25px)',
          fontWeight: 900,
          lineHeight: 1.3,
          letterSpacing: '0.02em',
          color: 'var(--ink)',
          textShadow: '0 2px 18px rgba(0,0,0,0.7)',
        }}
      >
        スマホを
        <br />
        自然に構えてください
      </div>

      {/* The only thing allowed to give way on a very short phone. */}
      <div style={{ flexShrink: 1, minHeight: 0, overflow: 'hidden', lineHeight: 0 }}>
        <NeutralPose color={color} />
      </div>

      <div
        aria-live="polite"
        key={shown}
        style={{
          flexShrink: 0,
          fontVariantNumeric: 'tabular-nums',
          fontFamily: 'var(--font-num)',
          fontSize: 'clamp(56px, 19vw, 86px)',
          fontWeight: 900,
          lineHeight: 0.9,
          color: '#ffffff',
          textShadow: `0 0 42px ${color}, 0 0 14px rgba(255,255,255,0.35)`,
          animation: 'kgs-cal-pop 520ms cubic-bezier(0.2,1.2,0.4,1)',
        }}
      >
        {shown}
      </div>

      <div
        style={{
          flexShrink: 0,
          fontSize: 15,
          fontWeight: 700,
          lineHeight: 1.55,
          color: 'rgba(226,238,248,0.82)',
        }}
      >
        そのまま 動かさないでください
        <br />
        <span style={{ fontSize: 13, color: 'var(--ink-dim)', fontWeight: 600 }}>
          いまの持ち方が 水槽のまんなかになります
        </span>
      </div>
    </div>
  );
}
