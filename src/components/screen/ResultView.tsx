'use client';

/**
 * The round result (spec §103, §104, §105).
 *
 * Ranking, each player's best fish, then the three special awards. Entries arrive one
 * after another so the crowd can follow a reveal instead of being handed a table.
 *
 * There is deliberately no button anywhere on this screen: the room returns to WAITING
 * on its own clock (§43), and a giant screen has no one standing at it with a mouse.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { audio } from '@/audio/AudioEngine';
import { PLAYER_COLORS } from '@/game/core/constants';
import { getFishData } from '@/game/fish/fishTypes';
import { formatScore } from '@/game/scoring/scoring';
import { TIME_UP_SECONDS } from '@/components/screen/PhaseOverlay';
import type { Award, GameResult, RankedPlayer } from '@/types';

export interface ResultViewProps {
  result: GameResult | null;
  /** Seconds until the room returns to WAITING, for the quiet progress line. */
  serverNow: () => number;
  endsAt: number | null;
}

/** Awards shown as their own row. BEST FISH is already printed on each player's line. */
const AWARD_ORDER: readonly Award['kind'][] = ['MOST_FISH', 'RARE_HUNTER', 'GENTLE_SCOOP'];

const AWARD_JP: Record<string, string> = {
  MOST_FISH: 'いちばん たくさん',
  RARE_HUNTER: 'レアハンター',
  GENTLE_SCOOP: 'やさしいすくい',
  BEST_FISH: 'いちばんの一匹',
};

const RANK_LABEL = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'] as const;
const RANK_COLOR = ['#f5c542', '#d7dbe4', '#c9884a', '#8c93a6'] as const;

const KEYFRAMES = `
@keyframes kingyo-rank-in {
  0%   { opacity: 0; transform: translateX(56px) scale(0.97); }
  100% { opacity: 1; transform: translateX(0) scale(1); }
}
@keyframes kingyo-award-in {
  0%   { opacity: 0; transform: translateY(18px) scale(0.94); }
  70%  { transform: translateY(0) scale(1.03); }
  100% { opacity: 1; transform: translateY(0) scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  @keyframes kingyo-rank-in { 0% { opacity: 0; } 100% { opacity: 1; } }
  @keyframes kingyo-award-in { 0% { opacity: 0; } 100% { opacity: 1; } }
}
`;

/** The ranking reveal starts once TIME UP has cleared the centre. */
const BASE_DELAY = TIME_UP_SECONDS + 0.15;
const ROW_STAGGER = 0.42;

function RankRow({ p, index }: { p: RankedPlayer; index: number }) {
  const color = p.color || PLAYER_COLORS[(p.number - 1) % PLAYER_COLORS.length];
  const medal = RANK_COLOR[Math.min(p.rank - 1, RANK_COLOR.length - 1)];
  const best = p.bestFish ? getFishData(p.bestFish.fishType) : null;
  const top = p.rank === 1;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'clamp(10px, 1.4vw, 24px)',
        padding: top ? '14px 20px' : '11px 20px',
        borderRadius: 14,
        background: top
          ? 'linear-gradient(90deg, rgba(245,197,66,0.20), rgba(10,12,24,0.66) 62%)'
          : 'rgba(10,12,24,0.62)',
        boxShadow: top
          ? `inset 0 0 0 1px rgba(245,197,66,0.45), 0 8px 34px rgba(0,0,0,0.5)`
          : `inset 0 0 0 1px ${color}33`,
        borderLeft: `6px solid ${color}`,
        animation: `kingyo-rank-in 520ms cubic-bezier(0.18, 0.9, 0.28, 1) both`,
        animationDelay: `${BASE_DELAY + index * ROW_STAGGER}s`,
      }}
    >
      <div
        className="tabular"
        style={{
          width: 'clamp(58px, 5vw, 92px)',
          fontSize: top ? 'clamp(30px, 3vw, 52px)' : 'clamp(22px, 2.1vw, 36px)',
          fontWeight: 700,
          color: medal,
          textShadow: top ? '0 0 26px rgba(245,197,66,0.6)' : 'none',
          lineHeight: 1,
        }}
      >
        {RANK_LABEL[Math.min(p.rank - 1, RANK_LABEL.length - 1)]}
      </div>

      <div
        className="tabular"
        style={{
          fontSize: 'clamp(18px, 1.6vw, 28px)',
          fontWeight: 700,
          color,
          letterSpacing: '0.05em',
          minWidth: 54,
          textShadow: `0 0 18px ${color}55`,
        }}
      >
        P{p.number}
      </div>

      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <div
          style={{
            fontSize: 'clamp(12px, 1vw, 15px)',
            color: 'var(--ink-dim)',
            letterSpacing: '0.12em',
          }}
        >
          BEST FISH
        </div>
        <div
          className="jp-title"
          style={{
            fontSize: 'clamp(15px, 1.4vw, 24px)',
            color: best ? 'var(--ink)' : 'rgba(169,160,143,0.6)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {best ? (
            <>
              {best.label}
              <span
                className="tabular"
                style={{ color: 'var(--gold)', marginLeft: 10, fontSize: '0.8em' }}
              >
                {best.score}pt
              </span>
            </>
          ) : (
            'すくえず'
          )}
        </div>
      </div>

      <div className="tabular" style={{ textAlign: 'right', minWidth: 'clamp(120px, 11vw, 210px)' }}>
        <div
          style={{
            fontSize: top ? 'clamp(34px, 3.4vw, 62px)' : 'clamp(26px, 2.5vw, 44px)',
            fontWeight: 700,
            lineHeight: 1,
            color: top ? 'var(--gold)' : 'var(--ink)',
            textShadow: top ? '0 0 30px rgba(245,197,66,0.5)' : '0 2px 8px rgba(0,0,0,0.7)',
          }}
        >
          {formatScore(p.score)}
        </div>
        <div style={{ fontSize: 'clamp(11px, 0.95vw, 15px)', color: 'var(--ink-dim)', marginTop: 4 }}>
          {p.fishCount}匹
        </div>
      </div>
    </div>
  );
}

function AwardCard({ award, index, count }: { award: Award | null; index: number; count: number }) {
  const kind = AWARD_ORDER[index];
  const color = award
    ? PLAYER_COLORS[(award.playerNumber - 1) % PLAYER_COLORS.length]
    : 'rgba(169,160,143,0.4)';

  return (
    <div
      style={{
        flex: '1 1 0',
        minWidth: 190,
        padding: '12px 16px 14px',
        borderRadius: 12,
        background: 'rgba(10,12,24,0.66)',
        boxShadow: `inset 0 0 0 1px ${award ? `${color}55` : 'rgba(255,255,255,0.08)'}`,
        textAlign: 'center',
        opacity: award ? 1 : 0.38,
        animation: 'kingyo-award-in 460ms cubic-bezier(0.2, 0.9, 0.3, 1) both',
        animationDelay: `${BASE_DELAY + count * ROW_STAGGER + 0.2 + index * 0.18}s`,
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: '0.26em',
          color: 'var(--lantern)',
        }}
      >
        {award?.label ?? kind.replace('_', ' ')}
      </div>
      <div className="jp-title" style={{ fontSize: 13, color: 'var(--ink-dim)', marginTop: 2 }}>
        {AWARD_JP[kind] ?? ''}
      </div>
      <div
        className="tabular"
        style={{
          marginTop: 8,
          fontSize: 'clamp(20px, 1.9vw, 32px)',
          fontWeight: 700,
          color: award ? color : 'inherit',
          textShadow: award ? `0 0 20px ${color}55` : 'none',
        }}
      >
        {award ? `P${award.playerNumber}` : '該当なし'}
      </div>
      <div style={{ fontSize: 13, color: 'var(--ink)', marginTop: 4 }}>{award?.detail ?? '—'}</div>
    </div>
  );
}

export function ResultView({ result, serverNow, endsAt }: ResultViewProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const [returnIn, setReturnIn] = useState<number | null>(null);

  const liveRef = useRef({ serverNow, endsAt });
  liveRef.current = { serverNow, endsAt };

  // The fanfare lands with the first ranking row, not with the phase change.
  // Keyed on 'finishedAt' rather than the object: the room heartbeat re-sends the same
  // result every second, and depending on identity would replay the fanfare each time.
  const finishedAt = result?.finishedAt ?? 0;
  useEffect(() => {
    if (finishedAt === 0) return undefined;
    const handle = window.setTimeout(() => {
      audio.play('resultFanfare', { volume: 0.9 });
    }, BASE_DELAY * 1000);
    return () => window.clearTimeout(handle);
  }, [finishedAt]);

  useEffect(() => {
    let raf = 0;
    let lastWhole = -1;
    // Captured on the first frame, in SERVER time, so the bar and the clock agree.
    let startedServer = 0;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const { serverNow: now, endsAt: end } = liveRef.current;
      if (end === null) return;
      const t = now();
      if (startedServer === 0) startedServer = t;
      const leftMs = Math.max(0, end - t);
      const total = Math.max(1, end - startedServer);
      const bar = barRef.current;
      if (bar) bar.style.transform = `scaleX(${Math.min(1, leftMs / total).toFixed(4)})`;
      const whole = Math.ceil(leftMs / 1000);
      if (whole !== lastWhole) {
        lastWhole = whole;
        setReturnIn(whole);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const rankings = useMemo(() => result?.rankings ?? [], [result]);
  const awards = useMemo(() => {
    const map = new Map<string, Award>();
    for (const a of result?.awards ?? []) map.set(a.kind, a);
    return AWARD_ORDER.map((k) => map.get(k) ?? null);
  }, [result]);

  if (!result) return null;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '3vh 3vw',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          width: 'min(1240px, 84vw)',
          maxHeight: '92vh',
          padding: 'clamp(18px, 2.4vh, 34px) clamp(22px, 2.8vw, 46px)',
          borderRadius: 22,
          background:
            'linear-gradient(160deg, rgba(10,12,24,0.82), rgba(7,8,15,0.74) 60%, rgba(10,12,24,0.82))',
          backdropFilter: 'blur(9px)',
          WebkitBackdropFilter: 'blur(9px)',
          boxShadow: '0 24px 90px rgba(0,0,0,0.65), inset 0 0 0 1px rgba(255,182,77,0.22)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'clamp(10px, 1.6vh, 20px)',
          // Holds off until TIME UP has had the centre to itself (spec §102).
          animation: 'kingyo-fade-in 480ms ease-out both',
          animationDelay: `${Math.max(0, TIME_UP_SECONDS - 0.35)}s`,
        }}
      >
        <style>{KEYFRAMES}</style>

        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'center',
            gap: 18,
            animation: 'kingyo-award-in 420ms ease-out both',
            animationDelay: `${TIME_UP_SECONDS}s`,
          }}
        >
          <h2
            className="jp-title"
            style={{
              margin: 0,
              fontSize: 'clamp(30px, 3.6vw, 62px)',
              color: 'var(--lantern)',
              letterSpacing: '0.16em',
              textShadow: '0 0 50px rgba(226,97,43,0.45)',
            }}
          >
            けっか
          </h2>
          <span
            className="tabular"
            style={{ fontSize: 'clamp(12px, 1.1vw, 18px)', letterSpacing: '0.34em', color: 'var(--ink-dim)' }}
          >
            RESULT
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {rankings.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--ink-dim)', padding: '26px 0' }}>
              このラウンドの参加者はいませんでした
            </div>
          ) : (
            rankings.map((p, i) => <RankRow key={p.id} p={p} index={i} />)
          )}
        </div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {awards.map((a, i) => (
            <AwardCard key={AWARD_ORDER[i]} award={a} index={i} count={rankings.length} />
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, paddingTop: 4 }}>
          <div
            style={{
              flex: '1 1 auto',
              height: 3,
              borderRadius: 2,
              background: 'rgba(255,255,255,0.08)',
              overflow: 'hidden',
            }}
          >
            <div
              ref={barRef}
              style={{
                height: '100%',
                width: '100%',
                transformOrigin: 'left center',
                background: 'linear-gradient(90deg, rgba(255,182,77,0.8), rgba(226,97,43,0.5))',
              }}
            />
          </div>
          <div
            className="tabular"
            style={{ fontSize: 13, color: 'var(--ink-dim)', whiteSpace: 'nowrap' }}
          >
            {returnIn !== null && returnIn > 0
              ? `つぎのゲームまで ${returnIn}`
              : 'まもなく つぎのゲーム'}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ResultView;
