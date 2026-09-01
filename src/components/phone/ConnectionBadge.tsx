'use client';

/**
 * Link and sensor health, in one quiet strip at the bottom of the phone.
 *
 * A player should never need to read this. It exists for the two moments when
 * something is wrong and a member of staff has to diagnose it from across a
 * noisy festival: "is the phone still talking to the tank?" and "is this device
 * actually producing motion data?".
 *
 * It is a readout, never a control (spec §23): nothing here is tappable.
 *
 * The gravityOnly warning matters more than it looks. Some Android browsers
 * never populate DeviceMotionEvent.acceleration, only accelerationIncludingGravity,
 * so the SensorAdapter has to estimate the linear part by subtracting a low-pass
 * gravity estimate. That still plays fine, but the lift gesture is a little less
 * crisp, and staff should know before they start debugging the player.
 */

import type { CSSProperties } from 'react';
import type { ControllerStatus } from '@/types';

export interface ConnectionBadgeProps {
  connected: boolean;
  latencyMs: number;
  status: ControllerStatus;
}

const NUMERIC: CSSProperties = {
  fontVariantNumeric: 'tabular-nums',
  fontFeatureSettings: '"tnum"',
};

const LABEL: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.14em',
  color: 'rgba(198,216,232,0.6)',
  lineHeight: 1,
  // 「つうし / ん」 mid-word breaks on a 360 px phone read as a broken screen.
  whiteSpace: 'nowrap',
};

const VALUE: CSSProperties = {
  ...NUMERIC,
  fontSize: 14,
  fontWeight: 800,
  lineHeight: 1,
  color: 'rgba(238,245,251,0.94)',
  whiteSpace: 'nowrap',
};

const linkColor = (connected: boolean, ms: number): string => {
  if (!connected) return '#e0483a';
  if (ms < 70) return '#4bd47a';
  if (ms < 150) return '#e8c33c';
  return '#e0483a';
};

interface SensorReport {
  text: string;
  color: string;
  /** A longer explanation, shown on its own line when something is off. */
  note: string | null;
}

const describeSensors = (s: ControllerStatus): SensorReport => {
  if (!s.supported || s.permission === 'unsupported') {
    return {
      text: '利用できません',
      color: '#e0483a',
      note: 'この端末ではモーションセンサーを利用できません。',
    };
  }
  if (s.permission === 'denied') {
    return {
      text: '許可されていません',
      color: '#e0483a',
      note: 'ブラウザの設定でモーションセンサーを許可してください。',
    };
  }
  if (!s.hasMotion && !s.hasOrientation) {
    return {
      text: '受信していません',
      color: '#e0483a',
      note: 'センサーの値がまだ届いていません。スマホを軽く動かしてください。',
    };
  }
  if (!s.hasMotion) {
    return {
      text: '傾きのみ',
      color: '#e8c33c',
      note: '加速度が届いていません。すくい上げの判定が鈍くなることがあります。',
    };
  }
  if (s.gravityOnly) {
    return {
      text: '簡易モード',
      color: '#e8c33c',
      note: 'この端末は加速度を直接出せないため、重力から推定して補正しています。',
    };
  }
  return { text: '良好', color: '#4bd47a', note: null };
};

export function ConnectionBadge({ connected, latencyMs, status }: ConnectionBadgeProps) {
  const dot = linkColor(connected, latencyMs);
  const sensor = describeSensors(status);
  const hz = Math.round(status.sampleRate);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        fontFamily: 'var(--font-ui)',
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}
    >
      <style>
        {'@keyframes kgs-cb-blink{0%,100%{opacity:1}50%{opacity:0.25}}'}
      </style>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: 9,
            flexShrink: 0,
            background: dot,
            boxShadow: `0 0 9px ${dot}`,
            animation: connected ? undefined : 'kgs-cb-blink 0.9s ease-in-out infinite',
          }}
        />
        <span style={LABEL}>つうしん</span>
        <span style={{ ...VALUE, color: connected ? VALUE.color : '#ff8a76' }}>
          {connected ? 'せつぞく中' : '切断'}
        </span>

        {/* Fixed width so the row never reflows as the latency wobbles. */}
        <span style={{ ...VALUE, minWidth: 58, textAlign: 'right', color: dot }}>
          {connected ? `${Math.min(999, Math.round(latencyMs))} ms` : '— ms'}
        </span>

        <span style={{ flex: 1 }} />

        <span style={LABEL}>センサー</span>
        <span style={{ ...VALUE, color: sensor.color }}>{sensor.text}</span>
        <span style={{ ...VALUE, minWidth: 46, textAlign: 'right', color: 'rgba(198,216,232,0.7)' }}>
          {hz > 0 ? `${Math.min(999, hz)}Hz` : '—'}
        </span>
      </div>

      {sensor.note !== null && (
        <div
          style={{
            fontSize: 12,
            lineHeight: 1.45,
            color: sensor.color === '#e8c33c' ? 'rgba(232,195,60,0.86)' : 'rgba(255,138,118,0.9)',
          }}
        >
          {sensor.note}
        </div>
      )}
    </div>
  );
}
