'use client';

/**
 * Short-lived capture notices at the right edge.
 *
 * A capture is already loud in the tank — slow motion, a burst of water, a score number
 * rising off the poi. This strip exists only so the audience can read WHAT was scooped:
 * one line, player colour, points, fish name. It rises, fades and gets out of the way,
 * and never more than four at once no matter how fast four players are scooping.
 */

import { useEffect, useRef, useState } from 'react';

import { PLAYER_COLORS } from '@/game/core/constants';
import { getFishData, RARITY_LABEL } from '@/game/fish/fishTypes';
import type { CapturePayload } from '@/network/protocol/events';

export interface CaptureFeedProps {
  /** Subscription from 'useScreenSocket'. Stable for the life of the page. */
  onCapture(cb: (p: CapturePayload) => void): () => void;
  /** Maximum notices on screen at once. */
  max?: number;
}

interface Notice {
  key: number;
  playerNumber: number;
  color: string;
  score: number;
  label: string;
  rarity: string;
  rare: boolean;
}

const LIFETIME_MS = 2600;

/**
 * One bespoke keyframe: slide in from the edge, hold long enough to be read, then rise
 * away. Chaining the two shared helpers instead would make the fill rules fight over
 * transform and opacity.
 */
const FEED_KEYFRAMES = `
@keyframes kingyo-feed {
  0%   { opacity: 0; transform: translateX(22px) scale(0.94); }
  7%   { opacity: 1; transform: translateX(0) scale(1); }
  62%  { opacity: 1; transform: translateY(0) scale(1); }
  100% { opacity: 0; transform: translateY(-58px) scale(0.98); }
}
@media (prefers-reduced-motion: reduce) {
  @keyframes kingyo-feed {
    0%   { opacity: 0; }
    7%   { opacity: 1; }
    62%  { opacity: 1; }
    100% { opacity: 0; }
  }
}
`;

export function CaptureFeed({ onCapture, max = 4 }: CaptureFeedProps) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Set<number>());

  useEffect(() => {
    const unsubscribe = onCapture((p) => {
      const data = getFishData(p.fishType);
      const key = ++seq.current;
      const notice: Notice = {
        key,
        playerNumber: p.playerNumber,
        color: PLAYER_COLORS[(p.playerNumber - 1) % PLAYER_COLORS.length],
        score: p.score,
        label: data.label,
        rarity: RARITY_LABEL[data.rarity],
        rare: data.rarity !== 'Common',
      };

      setNotices((list) => {
        const next = [notice, ...list];
        return next.length > max ? next.slice(0, max) : next;
      });

      const handle = window.setTimeout(() => {
        timers.current.delete(handle);
        setNotices((list) => list.filter((n) => n.key !== key));
      }, LIFETIME_MS);
      timers.current.add(handle);
    });

    return unsubscribe;
  }, [onCapture, max]);

  useEffect(() => {
    const store = timers.current;
    return () => {
      for (const handle of store) window.clearTimeout(handle);
      store.clear();
    };
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 6,
        pointerEvents: 'none',
      }}
    >
      <style>{FEED_KEYFRAMES}</style>
      {notices.map((n) => (
        <div
          key={n.key}
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 9,
            padding: '6px 13px 7px',
            borderRadius: 999,
            background: 'rgba(7,8,15,0.72)',
            boxShadow: `inset 0 0 0 1px ${n.color}55, 0 4px 18px rgba(0,0,0,0.5)`,
            whiteSpace: 'nowrap',
            animation: `kingyo-feed ${LIFETIME_MS}ms cubic-bezier(0.22, 0.7, 0.28, 1) both`,
          }}
        >
          <span
            className="tabular"
            style={{ color: n.color, fontWeight: 700, fontSize: 15, letterSpacing: '0.05em' }}
          >
            P{n.playerNumber}
          </span>
          <span
            className="tabular"
            style={{
              color: n.rare ? 'var(--gold)' : 'var(--ink)',
              fontWeight: 700,
              fontSize: 19,
              textShadow: n.rare ? '0 0 16px rgba(245,197,66,0.6)' : 'none',
            }}
          >
            +{n.score}
          </span>
          <span style={{ color: 'var(--ink)', fontSize: 15 }}>{n.label}</span>
          {n.rare ? (
            <span
              style={{
                color: 'var(--gold)',
                fontSize: 11,
                letterSpacing: '0.16em',
                opacity: 0.9,
              }}
            >
              {n.rarity}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export default CaptureFeed;
