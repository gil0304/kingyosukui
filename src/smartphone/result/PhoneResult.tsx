'use client';

/**
 * The phone's result screen (spec §106).
 *
 * Deliberately parochial: this shows ONLY this player's own result. The
 * ranking, the awards and everyone else's score belong on the giant screen,
 * where the crowd can see them. What the player holds in their hand is their
 * own score, their own count, their best fish, and — still swimming — their
 * own bowl.
 *
 * Celebratory but calm: things fade and settle rather than explode.
 */

import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { CapturedFish } from '@/types';
import { RARITY_LABEL, getFishData } from '@/game/fish/fishTypes';
import { bestFishOf, formatScore } from '@/game/scoring/scoring';
import { BowlCanvas } from '@/smartphone/bowl/BowlCanvas';
import { useCountUp } from '@/smartphone/status/StatusBar';

export interface PhoneResultProps {
  playerNumber: number;
  color: string;
  score: number;
  fishCount: number;
  capturedFish: readonly CapturedFish[];
  /** 1-based finishing position from 'rankPlayers'. */
  rank: number;
}

const FONT =
  '"Hiragino Kaku Gothic ProN", "Noto Sans JP", system-ui, -apple-system, sans-serif';

const LABEL: CSSProperties = {
  fontSize: 10,
  letterSpacing: '0.22em',
  fontWeight: 700,
  color: 'rgba(198,216,232,0.62)',
  lineHeight: 1,
};

const NUMERIC: CSSProperties = {
  fontVariantNumeric: 'tabular-nums',
  fontFeatureSettings: '"tnum"',
};

const rankColor = (rank: number): string =>
  rank === 1 ? '#f5c542' : rank === 2 ? '#cfd8df' : rank === 3 ? '#d9a05e' : '#8fa8bd';

export function PhoneResult({
  playerNumber,
  color,
  score,
  fishCount,
  capturedFish,
  rank,
}: PhoneResultProps) {
  // The count-up starts from 0 so the number climbs once, at the end.
  const shownScore = useCountUp(score, 1.4, 0);
  const best = useMemo(() => bestFishOf(capturedFish), [capturedFish]);
  const bestData = best ? getFishData(best.fishType) : null;
  const medal = rankColor(rank);

  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100%',
        gap: 14,
        padding:
          'calc(env(safe-area-inset-top, 0px) + 18px) calc(env(safe-area-inset-right, 0px) + 18px) calc(env(safe-area-inset-bottom, 0px) + 18px) calc(env(safe-area-inset-left, 0px) + 18px)',
        background:
          'radial-gradient(120% 70% at 50% 0%, rgba(28,52,80,0.85) 0%, rgba(7,12,20,1) 68%)',
        color: '#f2f7fb',
        fontFamily: FONT,
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}
    >
      <style>{`
        @keyframes kgs-res-rise{from{opacity:0;transform:translateY(14px)}
          to{opacity:1;transform:translateY(0)}}
        @keyframes kgs-res-glow{0%,100%{opacity:0.55}50%{opacity:1}}
      `}</style>

      {/* --- who --------------------------------------------------------- */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          animation: 'kgs-res-rise 420ms ease-out both',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 6,
            padding: '6px 12px 7px',
            borderRadius: 12,
            background: color,
            color: '#0b1119',
            boxShadow: `0 0 20px ${color}55`,
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.12em' }}>PLAYER</span>
          <span style={{ ...NUMERIC, fontSize: 22, fontWeight: 900, lineHeight: 1 }}>
            {playerNumber}
          </span>
        </div>
        <span style={{ flex: 1 }} />
        <div style={{ textAlign: 'right' }}>
          <div style={{ ...LABEL, marginBottom: 5 }}>じゅんい</div>
          <div
            style={{
              ...NUMERIC,
              fontSize: 26,
              fontWeight: 900,
              lineHeight: 1,
              color: medal,
              textShadow: `0 0 20px ${medal}66`,
            }}
          >
            {rank}
            <span style={{ fontSize: 14, marginLeft: 2 }}>位</span>
          </div>
        </div>
      </div>

      {/* --- score -------------------------------------------------------- */}
      <div
        style={{
          textAlign: 'center',
          padding: '18px 12px 20px',
          borderRadius: 18,
          background: 'rgba(9,16,26,0.72)',
          border: '1px solid rgba(120,160,190,0.16)',
          animation: 'kgs-res-rise 480ms 90ms ease-out both',
        }}
      >
        <div style={{ ...LABEL, marginBottom: 12 }}>SCORE</div>
        <div
          style={{
            ...NUMERIC,
            fontSize: 62,
            fontWeight: 900,
            lineHeight: 0.9,
            letterSpacing: '-0.02em',
            textShadow: `0 0 34px ${color}55`,
          }}
        >
          {formatScore(shownScore)}
        </div>
        <div
          style={{
            marginTop: 14,
            fontSize: 15,
            fontWeight: 700,
            color: 'rgba(214,230,242,0.86)',
          }}
        >
          すくった金魚{' '}
          <span style={{ ...NUMERIC, fontSize: 22, fontWeight: 900, color: '#ffffff' }}>
            {fishCount}
          </span>
          <span style={{ fontSize: 14, marginLeft: 2 }}>匹</span>
        </div>
      </div>

      {/* --- best fish ---------------------------------------------------- */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '13px 16px',
          borderRadius: 16,
          background: bestData
            ? `linear-gradient(100deg, ${bestData.colorBody}22 0%, rgba(9,16,26,0.75) 62%)`
            : 'rgba(9,16,26,0.72)',
          border: `1px solid ${bestData ? `${bestData.colorBody}55` : 'rgba(120,160,190,0.16)'}`,
          animation: 'kgs-res-rise 520ms 180ms ease-out both',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...LABEL, marginBottom: 9 }}>BEST FISH</div>
          {best && bestData ? (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span
                style={{
                  fontSize: 24,
                  fontWeight: 900,
                  lineHeight: 1,
                  color: '#ffffff',
                  textShadow:
                    bestData.sheen >= 0.8 ? '0 0 20px rgba(245,197,66,0.75)' : 'none',
                }}
              >
                {bestData.label}
              </span>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 800,
                  letterSpacing: '0.12em',
                  padding: '3px 7px',
                  borderRadius: 6,
                  background: `${bestData.colorBody}33`,
                  border: `1px solid ${bestData.colorBody}77`,
                  color: bestData.colorBody,
                }}
              >
                {RARITY_LABEL[bestData.rarity]}
              </span>
            </div>
          ) : (
            <div style={{ fontSize: 17, fontWeight: 800, color: 'rgba(214,230,242,0.72)' }}>
              つぎは すくえる
            </div>
          )}
        </div>
        {best && (
          <div
            style={{
              ...NUMERIC,
              fontSize: 26,
              fontWeight: 900,
              lineHeight: 1,
              color: bestData && bestData.sheen >= 0.8 ? '#f5c542' : '#ffffff',
            }}
          >
            {formatScore(best.score)}
            <span style={{ fontSize: 12, fontWeight: 700, marginLeft: 3 }}>pt</span>
          </div>
        )}
      </div>

      {/* --- the bowl the player takes home ------------------------------- */}
      <div
        style={{
          flex: 1,
          minHeight: 240,
          display: 'flex',
          flexDirection: 'column',
          animation: 'kgs-res-rise 600ms 280ms ease-out both',
        }}
      >
        <BowlCanvas capturedFish={capturedFish} style={{ flex: 1, minHeight: 220 }} />
      </div>

      <div
        style={{
          textAlign: 'center',
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: '0.14em',
          color: 'rgba(180,204,224,0.62)',
          animation: 'kgs-res-glow 3.4s ease-in-out infinite',
        }}
      >
        きょうの金魚たち
      </div>
    </div>
  );
}
