'use client';

/**
 * The four things a player has to understand (spec §132).
 *
 * This is the ONLY instruction anyone gets: they scan a QR code in a crowd, at
 * night, and about eight seconds later they are holding a poi. So each panel is
 * one drawing plus one short line, and the drawing does the work.
 *
 * Nothing here is interactive — every panel is visible at once, because a
 * first-time player should never have to hunt. (The drawings DO show touching
 * the screen: lateral steering is touch by owner decision, 2026-08-26.)
 *
 * Two variants:
 *   full    — shown on the join screen, before the player has ever played.
 *   compact — the reminder that sits under the bowl between rounds.
 */

import type { CSSProperties, ReactElement } from 'react';

const INK = 'var(--ink)';
const LANTERN = 'var(--lantern)';
const WATER = 'var(--water)';
const CRIMSON = 'var(--crimson)';
/** Faint dashed reference lines: "this is where it was before you moved it". */
const GUIDE = 'rgba(244,239,228,0.26)';

interface IconProps {
  size: number;
}

/** A wave of water, drawn from x=6 to x=58 at the given height. */
function Wave({ y }: { y: number }) {
  return (
    <path
      d={`M6 ${y} q 6.5 -4.5 13 0 t 13 0 t 13 0 t 13 0`}
      fill="none"
      stroke={WATER}
      strokeWidth="2.6"
      strokeLinecap="round"
      opacity="0.85"
    />
  );
}

/** うごかす — press toward an edge of the screen and the poi glides that way. */
function TiltIcon({ size }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      {/* the phone, upright — it does not tilt for this action */}
      <rect
        x="19"
        y="12"
        width="26"
        height="40"
        rx="5.5"
        fill="rgba(13,16,32,0.9)"
        stroke={INK}
        strokeWidth="2.6"
      />
      <rect x="23" y="17" width="18" height="30" rx="2.5" fill={WATER} opacity="0.35" />
      {/* the pressing finger: a dot with ripples, on the RIGHT half */}
      <circle cx="37.5" cy="33" r="3.6" fill={LANTERN} />
      <circle cx="37.5" cy="33" r="7" fill="none" stroke={LANTERN} strokeWidth="1.4" opacity="0.55" />
      <circle cx="37.5" cy="33" r="10.2" fill="none" stroke={LANTERN} strokeWidth="1.1" opacity="0.28" />
      {/* the lit chevron — identical to the one shown in play */}
      <path d="M50 26 l 6.5 7 l -6.5 7" fill="none" stroke={LANTERN} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 26 l -6.5 7 l 6.5 7" fill="none" stroke={GUIDE} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** おくへ・てまえへ — the same touch surface, vertical half. */
function PitchIcon({ size }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect
        x="19"
        y="12"
        width="26"
        height="40"
        rx="5.5"
        fill="rgba(13,16,32,0.9)"
        stroke={INK}
        strokeWidth="2.6"
      />
      <rect x="23" y="17" width="18" height="30" rx="2.5" fill={WATER} opacity="0.35" />
      {/* press the upper half → the poi glides away from you (奥へ) */}
      <circle cx="32" cy="24.5" r="3.6" fill={LANTERN} />
      <circle cx="32" cy="24.5" r="7" fill="none" stroke={LANTERN} strokeWidth="1.4" opacity="0.55" />
      <path d="M54 40 v -14" stroke={LANTERN} strokeWidth="3" strokeLinecap="round" />
      <path d="M54 21 l -4.5 7 h 9 z" fill={LANTERN} />
      <path d="M10 26 v 12" stroke={GUIDE} strokeWidth="2.4" strokeLinecap="round" />
      <path d="M10 42 l -4 -6 h 8 z" fill={GUIDE} />
    </svg>
  );
}

/** しずめる — TILT the phone nose-down and the poi goes into the water. */
function LowerIcon({ size }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      {/* where it was: upright, faint */}
      <rect
        x="24"
        y="10"
        width="17"
        height="28"
        rx="4"
        fill="none"
        stroke={GUIDE}
        strokeWidth="2"
        strokeDasharray="3 4"
      />
      {/* where it goes: nose tipped toward the water */}
      <g transform="translate(33 30) rotate(42)">
        <rect
          x="-8.5"
          y="-14"
          width="17"
          height="28"
          rx="4"
          fill="rgba(13,16,32,0.9)"
          stroke={INK}
          strokeWidth="2.6"
        />
        <rect x="-5" y="-9.5" width="10" height="17" rx="2" fill={WATER} opacity="0.35" />
      </g>
      {/* the rotation itself */}
      <path d="M45 12 a 16 16 0 0 1 8 15" fill="none" stroke={LANTERN} strokeWidth="2.6" strokeLinecap="round" />
      <path d="M53.5 32 l -5.5 -6 l 8.5 -1.5 z" fill={LANTERN} />
      <Wave y={55} />
    </svg>
  );
}

/** すくい上げる — tilt it back UP; the speed of the flick is the risk. */
function LiftIcon({ size }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <Wave y={55} />
      {/* the catch, clearing the water */}
      <g transform="translate(46 14)">
        <ellipse cx="0" cy="0" rx="5.2" ry="3.1" fill={CRIMSON} />
        <path d="M4.8 0 l 5.4 -3.8 v 7.6 z" fill={CRIMSON} />
      </g>
      {/* where it was: nose-down in the water, faint */}
      <g transform="translate(30 34) rotate(42)">
        <rect x="-8.5" y="-14" width="17" height="28" rx="4" fill="none" stroke={GUIDE} strokeWidth="2" strokeDasharray="3 4" />
      </g>
      {/* where it goes: nose tipped back up */}
      <g transform="translate(27 28) rotate(-30)">
        <rect
          x="-8.5"
          y="-14"
          width="17"
          height="28"
          rx="4"
          fill="rgba(13,16,32,0.9)"
          stroke={INK}
          strokeWidth="2.6"
        />
        <rect x="-5" y="-9.5" width="10" height="17" rx="2" fill={WATER} opacity="0.35" />
      </g>
      {/* the up-swing */}
      <path d="M50 44 a 18 18 0 0 0 -6 -19" fill="none" stroke={LANTERN} strokeWidth="2.6" strokeLinecap="round" />
      <path d="M43 22 l 8 1 l -4.5 7 z" fill={LANTERN} />
    </svg>
  );
}

interface Step {
  key: string;
  title: string;
  line: string;
  Icon: (p: IconProps) => ReactElement;
}

const STEPS: readonly Step[] = [
  { key: 'tilt', title: 'うごかす', line: '画面の右側を押すと右へ 左側を押すと左へ', Icon: TiltIcon },
  { key: 'pitch', title: 'おくへ・てまえへ', line: '画面の上のほうを押すと奥へ', Icon: PitchIcon },
  { key: 'lower', title: 'しずめる', line: 'スマホを下にかたむけると 水に入る', Icon: LowerIcon },
  { key: 'lift', title: 'すくい上げる', line: '上にかたむける。ゆっくりほど やぶれない', Icon: LiftIcon },
];

export interface HowToPlayProps {
  /** 'full' for the join screen, 'compact' for the between-rounds reminder. */
  variant?: 'full' | 'compact';
  style?: CSSProperties;
}

const PANEL_FULL: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '10px 11px 12px',
  borderRadius: 14,
  background: 'rgba(21,26,48,0.7)',
  border: '1px solid rgba(255,182,77,0.16)',
  minWidth: 0,
};

const PANEL_COMPACT: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 3,
  minWidth: 0,
};

export function HowToPlay({ variant = 'full', style }: HowToPlayProps) {
  const compact = variant === 'compact';

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: compact
          ? 'repeat(4, minmax(0, 1fr))'
          : 'repeat(2, minmax(0, 1fr))',
        gap: compact ? 8 : 10,
        width: '100%',
        fontFamily: 'var(--font-ui)',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        ...style,
      }}
    >
      {STEPS.map(({ key, title, line, Icon }) => (
        <div key={key} style={compact ? PANEL_COMPACT : PANEL_FULL}>
          <Icon size={compact ? 34 : 46} />
          <div
            style={{
              fontSize: compact ? 12.5 : 16,
              fontWeight: 800,
              color: INK,
              letterSpacing: '0.03em',
              lineHeight: 1.2,
              textAlign: compact ? 'center' : 'left',
              whiteSpace: 'nowrap',
            }}
          >
            {title}
          </div>
          {!compact && (
            <div
              style={{
                fontSize: 13,
                lineHeight: 1.45,
                color: 'var(--ink-dim)',
              }}
            >
              {line}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
