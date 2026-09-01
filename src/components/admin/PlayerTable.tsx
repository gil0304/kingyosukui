'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

import { POI } from '@/game/core/constants';
import { formatScore } from '@/game/scoring/scoring';
import type { AdminCommand } from '@/network/protocol/events';
import type { PlayerPublicState, PoiVerticalState, PoiWetnessStage } from '@/types';

export interface PlayerTableProps {
  players: PlayerPublicState[];
  maxPlayers: number;
  connected: boolean;
  send: (cmd: AdminCommand) => void;
}

const panel: CSSProperties = {
  background: 'var(--night-1)',
  border: '1px solid rgba(244, 239, 228, 0.10)',
  borderRadius: 8,
  padding: 14,
};

const panelTitle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.18em',
  color: 'var(--ink-dim)',
};

const th: CSSProperties = {
  textAlign: 'left',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.1em',
  color: 'rgba(169, 160, 143, 0.8)',
  padding: '0 8px 7px',
  whiteSpace: 'nowrap',
  borderBottom: '1px solid rgba(244, 239, 228, 0.14)',
};

const td: CSSProperties = {
  fontSize: 12,
  padding: '8px',
  whiteSpace: 'nowrap',
  verticalAlign: 'middle',
};

const POI_STATE_LABEL: Record<PoiVerticalState, string> = {
  Above: '水上',
  Entering: '進入',
  Submerged: '水中',
  Lifting: '引上げ',
  Raised: '保持',
  Broken: '破損',
  Respawning: '復帰中',
};

const POI_STATE_TONE: Record<PoiVerticalState, string> = {
  Above: 'var(--ink-dim)',
  Entering: 'var(--water)',
  Submerged: 'var(--water)',
  Lifting: 'var(--lantern)',
  Raised: 'var(--gold)',
  Broken: 'var(--crimson)',
  Respawning: 'var(--lantern-deep)',
};

const WETNESS_LABEL: Record<PoiWetnessStage, string> = {
  Dry: '乾き',
  Wet: '濡れ',
  VeryWet: '重濡れ',
  Tearing: '限界',
};

const WETNESS_TONE: Record<PoiWetnessStage, string> = {
  Dry: 'var(--ink-dim)',
  Wet: 'var(--water)',
  VeryWet: 'var(--lantern)',
  Tearing: 'var(--crimson)',
};

function durabilityTone(value: number): string {
  if (value > 60) return '#4bb264';
  if (value > 30) return 'var(--lantern)';
  return 'var(--crimson)';
}

/** The server names every bot seat with this prefix. */
export function isBotPlayer(p: PlayerPublicState): boolean {
  return /^BOT\s/.test(p.name);
}

function Flag({ on, yes, no, tone }: { on: boolean; yes: string; no: string; tone?: string }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.06em',
        color: on ? (tone ?? '#8ee6a1') : 'rgba(169, 160, 143, 0.55)',
      }}
    >
      {on ? yes : no}
    </span>
  );
}

function DurabilityBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value / POI.maxDurability));
  const tone = durabilityTone(value);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <div
        style={{
          position: 'relative',
          width: 62,
          height: 7,
          borderRadius: 4,
          background: 'rgba(244, 239, 228, 0.10)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            width: (pct * 100).toFixed(1) + '%',
            background: tone,
            transition: 'width 160ms linear, background 200ms linear',
          }}
        />
      </div>
      <span className="tabular" style={{ fontSize: 11, color: tone, minWidth: 26 }}>
        {Math.round(value)}
      </span>
    </div>
  );
}

function KickButton({
  disabled,
  onKick,
}: {
  disabled: boolean;
  onKick: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const onClick = useCallback(() => {
    if (armed) {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      setArmed(false);
      onKick();
      return;
    }
    setArmed(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setArmed(false), 5000);
  }, [armed, onKick]);

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        appearance: 'none',
        minWidth: 66,
        padding: '6px 9px',
        borderRadius: 5,
        fontFamily: 'var(--font-ui)',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.06em',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.34 : 1,
        background: armed ? 'var(--crimson)' : 'rgba(200, 53, 42, 0.14)',
        color: armed ? '#fff3ef' : '#ff9d92',
        border: '1px solid rgba(200, 53, 42, 0.6)',
      }}
    >
      {armed ? '確定？' : '退席'}
    </button>
  );
}

export function PlayerTable({ players, maxPlayers, connected, send }: PlayerTableProps) {
  const rows = [...players].sort((a, b) => a.number - b.number);
  const online = rows.filter((p) => p.connected).length;
  const offline = rows.length - online;

  return (
    <section style={panel}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 10,
          flexWrap: 'wrap',
        }}
      >
        <h2 style={panelTitle}>プレイヤー</h2>
        <div className="tabular" style={{ fontSize: 11, color: 'var(--ink-dim)' }}>
          接続 {online} / 席 {rows.length} / 定員 {maxPlayers}
          {offline > 0 ? (
            <span style={{ color: 'var(--crimson)', fontWeight: 700, marginLeft: 10 }}>
              切断 {offline} 人
            </span>
          ) : null}
        </div>
      </div>

      {offline > 0 ? (
        <div
          style={{
            marginBottom: 10,
            padding: '8px 10px',
            borderRadius: 6,
            background: 'rgba(200, 53, 42, 0.16)',
            border: '1px solid rgba(200, 53, 42, 0.5)',
            fontSize: 12,
            color: '#ffc9c2',
          }}
        >
          切断中のプレイヤーがいます。数秒で戻らない場合は、その席を退席させて次の人に渡してください。
        </div>
      ) : null}

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
          <thead>
            <tr>
              <th style={{ ...th, paddingLeft: 10 }}>席</th>
              <th style={th}>名前</th>
              <th style={th}>接続</th>
              <th style={th}>準備</th>
              <th style={th}>較正</th>
              <th style={th}>観戦</th>
              <th style={{ ...th, textAlign: 'right' }}>スコア</th>
              <th style={{ ...th, textAlign: 'right' }}>匹数</th>
              <th style={th}>ポイ耐久</th>
              <th style={th}>濡れ</th>
              <th style={th}>ポイ状態</th>
              <th style={{ ...th, textAlign: 'right' }}>破れ</th>
              <th style={{ ...th, textAlign: 'right', paddingRight: 10 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={13} style={{ ...td, padding: '26px 10px', color: 'var(--ink-dim)' }}>
                  まだ誰も参加していません。参加者スマホの URL、または QR を案内してください。
                </td>
              </tr>
            ) : null}

            {rows.map((p) => {
              const down = !p.connected;
              return (
                <tr
                  key={p.id}
                  style={{
                    background: down ? 'rgba(200, 53, 42, 0.16)' : 'transparent',
                    borderBottom: '1px solid rgba(244, 239, 228, 0.07)',
                    boxShadow: down ? 'inset 3px 0 0 0 var(--crimson)' : undefined,
                  }}
                >
                  <td style={{ ...td, paddingLeft: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span
                        style={{
                          width: 11,
                          height: 11,
                          borderRadius: 3,
                          background: p.color,
                          boxShadow: '0 0 8px ' + p.color,
                          flex: '0 0 auto',
                        }}
                      />
                      <span className="tabular" style={{ fontWeight: 700, fontSize: 13 }}>
                        P{p.number}
                      </span>
                    </div>
                  </td>

                  <td style={{ ...td, maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    <span style={{ color: down ? '#ffc9c2' : 'var(--ink)' }}>{p.name}</span>
                    {isBotPlayer(p) ? (
                      <span
                        style={{
                          marginLeft: 7,
                          padding: '1px 5px',
                          borderRadius: 3,
                          fontSize: 9,
                          fontWeight: 700,
                          letterSpacing: '0.1em',
                          color: 'var(--night-0)',
                          background: 'var(--ink-dim)',
                        }}
                      >
                        BOT
                      </span>
                    ) : null}
                  </td>

                  <td style={td}>
                    {down ? (
                      <span
                        style={{
                          display: 'inline-block',
                          padding: '2px 7px',
                          borderRadius: 4,
                          background: 'var(--crimson)',
                          color: '#fff3ef',
                          fontSize: 11,
                          fontWeight: 700,
                          letterSpacing: '0.1em',
                          animation: 'kingyo-pulse 1.1s ease-in-out infinite',
                        }}
                      >
                        切断
                      </span>
                    ) : (
                      <Flag on yes="接続" no="接続" />
                    )}
                  </td>

                  <td style={td}>
                    <Flag on={p.controllerReady} yes="完了" no="待ち" />
                  </td>
                  <td style={td}>
                    <Flag on={p.calibrated} yes="完了" no="未" />
                  </td>
                  <td style={td}>
                    <Flag on={p.spectating} yes="観戦中" no="参加" tone="var(--lantern)" />
                  </td>

                  <td className="tabular" style={{ ...td, textAlign: 'right', fontWeight: 700 }}>
                    {formatScore(p.score)}
                  </td>
                  <td className="tabular" style={{ ...td, textAlign: 'right' }}>
                    {p.fishCount}
                  </td>

                  <td style={td}>
                    <DurabilityBar value={p.poiDurability} />
                  </td>

                  <td style={td}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: WETNESS_TONE[p.poiStage] }}>
                      {WETNESS_LABEL[p.poiStage]}
                    </span>
                    <span className="tabular" style={{ fontSize: 11, color: 'var(--ink-dim)', marginLeft: 6 }}>
                      {Math.round(p.poiWetness * 100)}%
                    </span>
                  </td>

                  <td style={td}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: POI_STATE_TONE[p.poiState] }}>
                      {POI_STATE_LABEL[p.poiState]}
                    </span>
                  </td>

                  <td
                    className="tabular"
                    style={{
                      ...td,
                      textAlign: 'right',
                      color: p.poiBreaks > 0 ? 'var(--crimson)' : 'var(--ink-dim)',
                      fontWeight: p.poiBreaks > 0 ? 700 : 400,
                    }}
                  >
                    {p.poiBreaks}
                  </td>

                  <td style={{ ...td, textAlign: 'right', paddingRight: 10 }}>
                    <KickButton
                      disabled={!connected}
                      onKick={() => send({ type: 'KICK', playerId: p.id })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p style={{ margin: '10px 0 0', fontSize: 11, lineHeight: 1.6, color: 'rgba(169, 160, 143, 0.75)' }}>
        「退席」は 2 度押しで実行します（1 度目で確認、5 秒で解除）。退席させた席はすぐ次の人が使えます。
      </p>
    </section>
  );
}

export default PlayerTable;
