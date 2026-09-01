'use client';

/**
 * The condition of the player's paper (spec §51-§57, §96).
 *
 * Two parts:
 *  - a compact always-on indicator: how wet the paper is and how much of it is
 *    left, so a player can *feel* that lifting gently is the right idea (§55);
 *  - the break overlay (§96): 「ポイがやぶれた！」 with a 3-2-1 countdown drawn
 *    OVER the screen but deliberately transparent through the middle, because
 *    the fish already in the bowl must keep swimming underneath. Losing the poi
 *    never means losing what you caught.
 *
 * Like everything else on the phone, this is a readout: no buttons (§23).
 */

import type { CSSProperties } from 'react';
import { POI } from '@/game/core/constants';
import { clamp, clamp01 } from '@/game/core/math';
import { wetnessStage, type PoiVerticalState, type PoiWetnessStage } from '@/types';

export interface PoiStatusProps {
  /** 0..'POI.maxDurability'. */
  durability: number;
  /** 0..1. */
  wetness: number;
  state: PoiVerticalState;
  /** Seconds until a broken poi is replaced, or 0. */
  respawnIn: number;
}

const STAGE_LABEL: Record<PoiWetnessStage, string> = {
  Dry: 'かわいている',
  Wet: 'ぬれてきた',
  VeryWet: 'びしょぬれ',
  Tearing: 'やぶれそう',
};

const STAGE_COLOR: Record<PoiWetnessStage, string> = {
  Dry: '#7fd8a4',
  Wet: '#5cc0e8',
  VeryWet: '#e8c33c',
  Tearing: '#ff6b52',
};

const STATE_LABEL: Partial<Record<PoiVerticalState, string>> = {
  Above: 'かまえている',
  Entering: '水に入れている',
  Submerged: '水の中',
  Lifting: 'すくい上げ中',
  Raised: 'ひきあげた',
  Broken: 'やぶれた',
  Respawning: '準備中',
};

/** Green while healthy, amber as it softens, red once it is about to go. */
const durabilityColor = (ratio: number): string =>
  ratio > 0.6 ? '#7fd8a4' : ratio > 0.3 ? '#e8c33c' : '#ff6b52';

const LABEL: CSSProperties = {
  fontSize: 10,
  letterSpacing: '0.16em',
  fontWeight: 700,
  color: 'rgba(198,216,232,0.66)',
  lineHeight: 1,
  whiteSpace: 'nowrap',
};

/** Status words are short and fixed: let them shrink the row, never wrap. */
const NOWRAP: CSSProperties = { whiteSpace: 'nowrap' };

/** A little procedural poi: bamboo ring, paper, and a hole that grows. */
function PoiGlyph({ tear, size }: { tear: number; size: number }) {
  const hole = clamp01(tear);
  const r = 15;
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r={r} fill="rgba(244,238,224,0.9)" />
      {hole > 0.02 && (
        <path
          d={`M20 ${20 - r * hole} L${20 + r * hole * 0.55} ${20 - r * hole * 0.35}
              L${20 + r * hole * 0.4} ${20 + r * hole * 0.5} L20 ${20 + r * hole}
              L${20 - r * hole * 0.5} ${20 + r * hole * 0.3}
              L${20 - r * hole * 0.42} ${20 - r * hole * 0.55} Z`}
          fill="#0a1018"
        />
      )}
      <circle cx="20" cy="20" r={r} fill="none" stroke="#c9a227" strokeWidth="3" />
      <rect x="19" y="33" width="2.4" height="7" rx="1.2" fill="#c9a227" />
    </svg>
  );
}

export function PoiStatus({ durability, wetness, state, respawnIn }: PoiStatusProps) {
  const ratio = clamp01(durability / POI.maxDurability);
  const stage = wetnessStage(clamp01(wetness));
  const broken = state === 'Broken' || state === 'Respawning';
  // Paper thins before it tears — mirror that in the glyph.
  const tear = clamp01((1 - ratio - 0.35) / 0.65) * 0.9;
  const count = clamp(Math.ceil(respawnIn), 1, Math.ceil(POI.respawnSeconds));

  return (
    <>
      <style>{`
        @keyframes kgs-poi-pop{0%{transform:scale(0.45);opacity:0}
          28%{transform:scale(1.12);opacity:1}100%{transform:scale(1);opacity:1}}
        @keyframes kgs-poi-shake{0%,100%{transform:translateX(0) rotate(0deg)}
          25%{transform:translateX(-2px) rotate(-2deg)}75%{transform:translateX(2px) rotate(2deg)}}
        @keyframes kgs-poi-fade{from{opacity:0}to{opacity:1}}
      `}</style>

      {/* --- the always-on paper readout ---------------------------------- */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 14px',
          borderRadius: 14,
          background: 'rgba(10,17,27,0.82)',
          border: '1px solid rgba(120,160,190,0.18)',
          color: '#eef5fb',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          fontFamily:
            '"Hiragino Kaku Gothic ProN", "Noto Sans JP", system-ui, -apple-system, sans-serif',
          opacity: broken ? 0.55 : 1,
        }}
      >
        <div
          style={{
            flexShrink: 0,
            animation: stage === 'Tearing' && !broken
              ? 'kgs-poi-shake 0.45s ease-in-out infinite'
              : undefined,
          }}
        >
          <PoiGlyph tear={broken ? 1 : tear} size={38} />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 8,
              marginBottom: 7,
              minWidth: 0,
            }}
          >
            <span style={LABEL}>ポイ</span>
            <span
              style={{
                fontSize: 15,
                fontWeight: 800,
                color: broken ? '#ff8a76' : STAGE_COLOR[stage],
                lineHeight: 1,
                ...NOWRAP,
              }}
            >
              {broken ? '新しいポイを準備中' : STAGE_LABEL[stage]}
            </span>
            <span style={{ flex: 1, minWidth: 4 }} />
            {/* The least important of the three: first to go when space is tight. */}
            <span
              style={{
                ...LABEL,
                letterSpacing: '0.08em',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {STATE_LABEL[state] ?? ''}
            </span>
          </div>

          {/* durability */}
          <div
            style={{
              position: 'relative',
              height: 9,
              borderRadius: 9,
              background: 'rgba(255,255,255,0.09)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                position: 'absolute',
                inset: 0,
                width: `${(ratio * 100).toFixed(1)}%`,
                borderRadius: 9,
                background: `linear-gradient(90deg, ${durabilityColor(ratio)} 0%, ${durabilityColor(
                  ratio,
                )}bb 100%)`,
                boxShadow: `0 0 10px ${durabilityColor(ratio)}77`,
                transition: 'width 180ms linear',
              }}
            />
          </div>
        </div>

        <div
          style={{
            fontVariantNumeric: 'tabular-nums',
            fontSize: 18,
            fontWeight: 900,
            color: durabilityColor(ratio),
            minWidth: 44,
            textAlign: 'right',
          }}
        >
          {Math.round(ratio * 100)}
          <span style={{ fontSize: 11, fontWeight: 700, marginLeft: 1 }}>%</span>
        </div>
      </div>

      {/* --- §96 break overlay: never hides the bowl ----------------------- */}
      {broken && (
        <div
          aria-live="polite"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 40,
            pointerEvents: 'none',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding:
              'calc(env(safe-area-inset-top, 0px) + 84px) 20px calc(env(safe-area-inset-bottom, 0px) + 40px)',
            // Dark at the ends, clear through the middle — the fish keep
            // swimming in plain sight while the paper is replaced.
            background:
              'linear-gradient(180deg, rgba(8,13,21,0.9) 0%, rgba(8,13,21,0.55) 22%, rgba(8,13,21,0) 42%, rgba(8,13,21,0) 60%, rgba(8,13,21,0.72) 88%, rgba(8,13,21,0.94) 100%)',
            animation: 'kgs-poi-fade 220ms ease-out',
            fontFamily:
              '"Hiragino Kaku Gothic ProN", "Noto Sans JP", system-ui, -apple-system, sans-serif',
            textAlign: 'center',
            userSelect: 'none',
            WebkitUserSelect: 'none',
          }}
        >
          <div>
            <div
              style={{
                fontSize: 30,
                fontWeight: 900,
                letterSpacing: '0.04em',
                color: '#ff7a5f',
                textShadow: '0 0 26px rgba(255,90,60,0.55), 0 2px 0 rgba(0,0,0,0.6)',
                animation: 'kgs-poi-pop 420ms cubic-bezier(0.2,1.2,0.4,1)',
              }}
            >
              ポイがやぶれた！
            </div>
            <div
              style={{
                marginTop: 10,
                fontSize: 15,
                fontWeight: 700,
                color: 'rgba(226,238,248,0.88)',
                letterSpacing: '0.06em',
              }}
            >
              新しいポイを準備中…
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <div
              key={count}
              style={{
                fontVariantNumeric: 'tabular-nums',
                fontSize: 76,
                fontWeight: 900,
                lineHeight: 1,
                color: '#ffffff',
                textShadow: '0 0 34px rgba(120,200,255,0.6)',
                animation: 'kgs-poi-pop 520ms cubic-bezier(0.2,1.2,0.4,1)',
              }}
            >
              {count}
            </div>
            <div style={{ ...LABEL, letterSpacing: '0.26em' }}>すくった金魚はそのまま</div>
          </div>
        </div>
      )}
    </>
  );
}
