'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

import { GAME, POI } from '@/game/core/constants';
import type { AdminCommand } from '@/network/protocol/events';
import type { RoomSettings, RoomState } from '@/types';

export interface SettingsPanelProps {
  settings: RoomSettings | null;
  state: RoomState;
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
  margin: '0 0 4px',
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.18em',
  color: 'var(--ink-dim)',
};

const panelNote: CSSProperties = {
  margin: '0 0 10px',
  fontSize: 11,
  lineHeight: 1.6,
  color: 'rgba(169, 160, 143, 0.75)',
};

const fieldNote: CSSProperties = {
  margin: '4px 0 0',
  fontSize: 11,
  lineHeight: 1.55,
  color: 'var(--ink-dim)',
};

const fieldWrap: CSSProperties = {
  padding: '11px 0',
  borderTop: '1px solid rgba(244, 239, 228, 0.07)',
};

const labelRow: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 10,
};

const labelText: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: '0.04em',
  color: 'var(--ink)',
};

const valueText: CSSProperties = {
  fontSize: 17,
  fontWeight: 700,
  color: 'var(--lantern)',
};

const rangeStyle: CSSProperties = {
  width: '100%',
  marginTop: 8,
  accentColor: 'var(--lantern)',
  cursor: 'pointer',
};

/** How long a slider drag is held locally before the change is sent. */
const SLIDER_DEBOUNCE_MS = 170;

export function SettingsPanel({ settings, state, connected, send }: SettingsPanelProps) {
  /** Values the operator has moved but the server has not confirmed yet. */
  const [draft, setDraft] = useState<Partial<RoomSettings>>({});
  const sentRef = useRef<Partial<RoomSettings>>({});
  const awaitingRef = useRef<Set<keyof RoomSettings>>(new Set());
  const timersRef = useRef<Map<keyof RoomSettings, number>>(new Map());

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const id of timers.values()) window.clearTimeout(id);
      timers.clear();
    };
  }, []);

  // The server is the authority. As soon as it answers a change we sent, drop the
  // local copy of that field so a clamped value is what the operator sees.
  useEffect(() => {
    if (!settings) return;
    if (awaitingRef.current.size === 0) return;
    const settled: (keyof RoomSettings)[] = [];
    awaitingRef.current.forEach((key) => {
      // Still moving this field: keep the local value, the next send settles it.
      if (draft[key] === sentRef.current[key]) settled.push(key);
    });
    if (settled.length === 0) return;
    for (const key of settled) {
      awaitingRef.current.delete(key);
      delete sentRef.current[key];
    }
    setDraft((prev) => {
      const next: Partial<RoomSettings> = { ...prev };
      for (const key of settled) delete next[key];
      return next;
    });
  }, [settings, draft]);

  const apply = useCallback(
    (key: keyof RoomSettings, patch: Partial<RoomSettings>, delayMs: number) => {
      setDraft((prev) => ({ ...prev, ...patch }));
      const timers = timersRef.current;
      const pending = timers.get(key);
      if (pending !== undefined) window.clearTimeout(pending);
      const fire = () => {
        timers.delete(key);
        Object.assign(sentRef.current, patch);
        awaitingRef.current.add(key);
        send({ type: 'SETTINGS', settings: patch });
      };
      if (delayMs <= 0) fire();
      else timers.set(key, window.setTimeout(fire, delayMs));
    },
    [send],
  );

  if (!settings) {
    return (
      <section style={panel}>
        <h2 style={panelTitle}>ゲーム設定</h2>
        <p style={panelNote}>ルームの状態を受信するまで設定は編集できません。</p>
      </section>
    );
  }

  const disabled = !connected;
  const durationSeconds = draft.durationSeconds ?? settings.durationSeconds;
  const fishCount = draft.fishCount ?? settings.fishCount;
  const maxPlayers = draft.maxPlayers ?? settings.maxPlayers;
  const poiBreakPenalty = draft.poiBreakPenalty ?? settings.poiBreakPenalty;
  const audioEnabled = draft.audioEnabled ?? settings.audioEnabled;
  const highQuality = draft.highQuality ?? settings.highQuality;

  const fishCountLive = state === 'WAITING';

  const toggle = (
    key: keyof RoomSettings,
    label: string,
    note: string,
    value: boolean,
    patch: (v: boolean) => Partial<RoomSettings>,
  ) => (
    <div style={fieldWrap}>
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.4 : 1,
        }}
      >
        <input
          type="checkbox"
          checked={value}
          disabled={disabled}
          onChange={(e) => apply(key, patch(e.currentTarget.checked), 0)}
          style={{ width: 17, height: 17, accentColor: 'var(--lantern)', cursor: 'inherit' }}
        />
        <span style={labelText}>{label}</span>
        <span
          className="tabular"
          style={{
            marginLeft: 'auto',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.08em',
            color: value ? '#8ee6a1' : 'var(--ink-dim)',
          }}
        >
          {value ? 'ON' : 'OFF'}
        </span>
      </label>
      <p style={{ ...fieldNote, marginLeft: 27 }}>{note}</p>
    </div>
  );

  return (
    <section style={panel}>
      <h2 style={panelTitle}>ゲーム設定</h2>
      <p style={panelNote}>
        変更はサーバーへ送られ、確定した値がここに戻ってきます。範囲外の値は自動的に丸められます。
      </p>

      <div style={fieldWrap}>
        <div style={labelRow}>
          <span style={labelText}>制限時間</span>
          <span className="tabular" style={valueText}>
            {durationSeconds}
            <span style={{ fontSize: 12, marginLeft: 3, color: 'var(--ink-dim)' }}>秒</span>
          </span>
        </div>
        <input
          type="range"
          min={GAME.minDurationSeconds}
          max={GAME.maxDurationSeconds}
          step={1}
          value={durationSeconds}
          disabled={disabled}
          onChange={(e) =>
            apply(
              'durationSeconds',
              { durationSeconds: Number(e.currentTarget.value) },
              SLIDER_DEBOUNCE_MS,
            )
          }
          style={rangeStyle}
        />
        <p style={fieldNote}>
          1 ラウンドの長さ（{GAME.minDurationSeconds}〜{GAME.maxDurationSeconds} 秒）。
          プレイ中に変更した場合は次のラウンドから反映されます。
        </p>
      </div>

      <div style={fieldWrap}>
        <div style={labelRow}>
          <span style={labelText}>金魚の数</span>
          <span className="tabular" style={valueText}>
            {fishCount}
            <span style={{ fontSize: 12, marginLeft: 3, color: 'var(--ink-dim)' }}>匹</span>
          </span>
        </div>
        <input
          type="range"
          min={GAME.minFishCount}
          max={GAME.maxFishCount}
          step={5}
          value={fishCount}
          disabled={disabled}
          onChange={(e) =>
            apply('fishCount', { fishCount: Number(e.currentTarget.value) }, SLIDER_DEBOUNCE_MS)
          }
          style={rangeStyle}
        />
        <p style={fieldNote}>
          {GAME.minFishCount}〜{GAME.maxFishCount} 匹。
          <span style={{ color: 'var(--lantern)' }}>
            巨大スクリーンのフレームレートが落ちるときは、まずこの数を減らしてください。
          </span>
          {fishCountLive
            ? ' 待機中なので、変更するとすぐに水槽へ反映されます。'
            : ' 水槽への反映は次の待機画面（リセット後）です。'}
        </p>
      </div>

      <div style={fieldWrap}>
        <div style={labelRow}>
          <span style={labelText}>最大人数</span>
          <span className="tabular" style={valueText}>
            {maxPlayers}
            <span style={{ fontSize: 12, marginLeft: 3, color: 'var(--ink-dim)' }}>人</span>
          </span>
        </div>
        <input
          type="range"
          min={1}
          max={GAME.hardMaxPlayers}
          step={1}
          value={maxPlayers}
          disabled={disabled}
          onChange={(e) => apply('maxPlayers', { maxPlayers: Number(e.currentTarget.value) }, 0)}
          style={rangeStyle}
        />
        <p style={fieldNote}>
          同時に参加できる席の数。通常の運用は 4 人です（最大 {GAME.hardMaxPlayers} 人）。
          減らしても、すでに座っている人は追い出されません。
        </p>
      </div>

      {toggle(
        'poiBreakPenalty',
        'ポイ破れペナルティ',
        'ポイが破れたとき ' + POI.breakPenalty + ' 点減点します。OFF にすると破れても減点なし。',
        poiBreakPenalty,
        (v) => ({ poiBreakPenalty: v }),
      )}

      {toggle(
        'audioEnabled',
        '音声',
        '巨大スクリーンの効果音と祭囃子の環境音。会場が静かな時間帯は OFF に。',
        audioEnabled,
        (v) => ({ audioEnabled: v }),
      )}

      {toggle(
        'highQuality',
        '高画質',
        'ポストプロセス（ブルーム・ビネット）と高精細な水面。重いときは OFF にすると軽くなります。',
        highQuality,
        (v) => ({ highQuality: v }),
      )}
    </section>
  );
}

export default SettingsPanel;
