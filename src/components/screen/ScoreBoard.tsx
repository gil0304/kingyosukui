'use client';

/**
 * The score column at the right edge (spec §100).
 *
 * Rows are ordered by SEAT NUMBER, never by score. On a giant screen a row that jumps
 * position the instant someone scores is genuinely disorienting — the audience loses the
 * player they were following. Ranking is what the RESULT screen is for; during the round
 * each player owns a fixed slot, and the only thing that moves is the number in it.
 */

import { useEffect, useRef, useState } from 'react';

import { POI } from '@/game/core/constants';
import { clamp01 } from '@/game/core/math';
import { formatScore } from '@/game/scoring/scoring';
import type { PlayerPublicState } from '@/types';

export interface ScoreBoardProps {
  players: readonly PlayerPublicState[];
  /** Dim the whole column while the round has not started yet. */
  dim?: boolean;
}

const FLASH_MS = 620;

const stageLabel: Record<string, string> = {
  Dry: '',
  Wet: 'ぬれ',
  VeryWet: 'かなり ぬれ',
  Tearing: 'やぶれそう',
};

export function ScoreBoard({ players, dim = false }: ScoreBoardProps) {
  const seats = [...players].filter((p) => !p.spectating).sort((a, b) => a.number - b.number);

  const previous = useRef(new Map<string, number>());
  const timers = useRef(new Map<string, number>());
  const [flashing, setFlashing] = useState<Record<string, number>>({});

  useEffect(() => {
    const prev = previous.current;
    let next: Record<string, number> | null = null;

    for (const p of seats) {
      const before = prev.get(p.id);
      prev.set(p.id, p.score);
      if (before === undefined || before === p.score) continue;
      if (!next) next = {};
      next[p.id] = p.score > before ? 1 : -1;
    }

    if (!next) return;
    const stamp = next;
    setFlashing((f) => ({ ...f, ...stamp }));

    for (const id of Object.keys(stamp)) {
      const existing = timers.current.get(id);
      if (existing) window.clearTimeout(existing);
      const handle = window.setTimeout(() => {
        timers.current.delete(id);
        setFlashing((f) => {
          if (!(id in f)) return f;
          const copy = { ...f };
          delete copy[id];
          return copy;
        });
      }, FLASH_MS);
      timers.current.set(id, handle);
    }
  });

  useEffect(() => {
    const store = timers.current;
    return () => {
      for (const handle of store.values()) window.clearTimeout(handle);
      store.clear();
    };
  }, []);

  if (seats.length === 0) return null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        width: 'clamp(230px, 17vw, 320px)',
        opacity: dim ? 0.62 : 1,
        transition: 'opacity 400ms ease',
      }}
    >
      {seats.map((p) => {
        const flash = flashing[p.id] ?? 0;
        const durability = clamp01(p.poiDurability / POI.maxDurability);
        const broken = p.poiState === 'Broken' || p.poiState === 'Respawning';
        const wet = stageLabel[p.poiStage] ?? '';

        return (
          <div
            key={p.id}
            style={{
              position: 'relative',
              padding: '10px 14px 11px 16px',
              borderRadius: 10,
              background:
                flash > 0
                  ? 'linear-gradient(90deg, rgba(255,182,77,0.30), rgba(13,16,32,0.80))'
                  : 'linear-gradient(90deg, rgba(13,16,32,0.72), rgba(13,16,32,0.62))',
              boxShadow: flash > 0 ? `0 0 26px ${p.color}66` : '0 2px 14px rgba(0,0,0,0.45)',
              borderLeft: `5px solid ${p.color}`,
              transition: 'background 380ms ease, box-shadow 380ms ease, transform 220ms ease',
              transform: flash > 0 ? 'translateX(-6px)' : 'none',
              opacity: p.connected ? 1 : 0.45,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span
                className="tabular"
                style={{
                  color: p.color,
                  fontSize: 17,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  textShadow: `0 0 14px ${p.color}55`,
                }}
              >
                P{p.number}
              </span>

              <span
                className="tabular"
                style={{
                  marginLeft: 'auto',
                  fontSize: 'clamp(24px, 2.1vw, 36px)',
                  fontWeight: 700,
                  lineHeight: 1,
                  color: flash > 0 ? 'var(--lantern)' : 'var(--ink)',
                  textShadow: '0 2px 8px rgba(0,0,0,0.75)',
                  transition: 'color 380ms ease',
                }}
              >
                {formatScore(p.score)}
              </span>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginTop: 5,
                fontSize: 12,
                color: 'var(--ink-dim)',
              }}
            >
              <span className="tabular">{p.fishCount}匹</span>
              {!p.connected ? (
                <span style={{ color: '#d8735f' }}>切断</span>
              ) : broken ? (
                <span style={{ color: '#ff9d6b' }}>ポイ交換中</span>
              ) : wet ? (
                <span style={{ color: p.poiStage === 'Tearing' ? '#ff8a70' : 'var(--ink-dim)' }}>
                  {wet}
                </span>
              ) : null}
            </div>

            {/* poi durability — deliberately quiet: it is a warning, not a gauge to play */}
            <div
              style={{
                marginTop: 7,
                height: 3,
                borderRadius: 2,
                background: 'rgba(255,255,255,0.09)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${(broken ? 0 : durability) * 100}%`,
                  borderRadius: 2,
                  background:
                    durability > 0.55
                      ? 'rgba(244,239,228,0.55)'
                      : durability > 0.25
                        ? 'rgba(255,182,77,0.85)'
                        : 'rgba(200,53,42,0.95)',
                  transition: 'width 260ms linear, background 300ms linear',
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default ScoreBoard;
