'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import type { AdminCommand } from '@/network/protocol/events';
import type { RoomState } from '@/types';

export interface RoomControlsProps {
  roomId: string;
  state: RoomState;
  connected: boolean;
  /** Players that are connected and controller-ready right now. */
  readyCount: number;
  /** Seats currently held by server-driven bots. */
  botCount: number;
  /** Seats still free (maxPlayers minus occupied seats). */
  freeSeats: number;
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
  margin: '0 0 12px',
  fontSize: 11,
  lineHeight: 1.6,
  color: 'rgba(169, 160, 143, 0.75)',
};

const rowNote: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.5,
  color: 'var(--ink-dim)',
  margin: '3px 0 0',
};

type Tone = 'normal' | 'primary' | 'danger';

function buttonStyle(tone: Tone, disabled: boolean): CSSProperties {
  const base: CSSProperties = {
    appearance: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minWidth: 92,
    padding: '9px 14px',
    borderRadius: 6,
    fontFamily: 'var(--font-ui)',
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '0.06em',
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'background 120ms ease, border-color 120ms ease',
    opacity: disabled ? 0.34 : 1,
  };
  if (tone === 'primary') {
    return {
      ...base,
      background: disabled ? 'rgba(255, 182, 77, 0.12)' : 'var(--lantern)',
      color: disabled ? 'var(--ink-dim)' : '#231303',
      border: '1px solid var(--lantern)',
    };
  }
  if (tone === 'danger') {
    return {
      ...base,
      background: 'rgba(200, 53, 42, 0.16)',
      color: '#ff9d92',
      border: '1px solid rgba(200, 53, 42, 0.62)',
    };
  }
  return {
    ...base,
    background: 'var(--night-2)',
    color: 'var(--ink)',
    border: '1px solid rgba(244, 239, 228, 0.16)',
  };
}

function ControlRow({
  children,
  note,
}: {
  children: ReactNode;
  note: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '10px 0',
        borderTop: '1px solid rgba(244, 239, 228, 0.07)',
      }}
    >
      <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8 }}>{children}</div>
      <p style={{ ...rowNote, flex: '1 1 auto', marginTop: 6 }}>{note}</p>
    </div>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path below (blocked or insecure context).
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

function UrlRow({ label, hint, url }: { label: string; hint: string; url: string }) {
  const [flash, setFlash] = useState<'idle' | 'ok' | 'ng'>('idle');
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const onCopy = useCallback(async () => {
    if (!url) return;
    const ok = await copyText(url);
    setFlash(ok ? 'ok' : 'ng');
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setFlash('idle'), 1800);
  }, [url]);

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--ink-dim)' }}>
          {label}
        </span>
        <span style={{ fontSize: 10, color: 'rgba(169, 160, 143, 0.7)' }}>{hint}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <input
          readOnly
          value={url || '読み込み中…'}
          onFocus={(e) => e.currentTarget.select()}
          className="tabular"
          style={{
            flex: '1 1 auto',
            minWidth: 0,
            background: 'var(--night-0)',
            border: '1px solid rgba(244, 239, 228, 0.14)',
            borderRadius: 5,
            color: 'var(--water)',
            fontSize: 12,
            padding: '7px 9px',
          }}
        />
        <button
          type="button"
          onClick={() => {
            void onCopy();
          }}
          disabled={!url}
          style={{
            ...buttonStyle('normal', !url),
            minWidth: 74,
            padding: '7px 10px',
            fontSize: 12,
            color: flash === 'ok' ? '#8ee6a1' : flash === 'ng' ? '#ff9d92' : 'var(--ink)',
          }}
        >
          {flash === 'ok' ? 'コピー済' : flash === 'ng' ? '失敗' : 'コピー'}
        </button>
      </div>
    </div>
  );
}

export function RoomControls({
  roomId,
  state,
  connected,
  readyCount,
  botCount,
  freeSeats,
  send,
}: RoomControlsProps) {
  const [origin, setOrigin] = useState('');
  const [botAdd, setBotAdd] = useState(1);
  const [confirmReset, setConfirmReset] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    },
    [],
  );

  const armReset = useCallback(() => {
    setConfirmReset(true);
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => setConfirmReset(false), 8000);
  }, []);

  const cancelReset = useCallback(() => {
    setConfirmReset(false);
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  const doReset = useCallback(() => {
    cancelReset();
    send({ type: 'RESET' });
  }, [cancelReset, send]);

  const canStart = connected && (state === 'WAITING' || state === 'RESULT');
  const canSkip = connected && state === 'PLAYING';
  const canAddBot = connected && freeSeats > 0;
  const canClearBots = connected && botCount > 0;
  const addable = Math.max(1, Math.min(botAdd, freeSeats > 0 ? freeSeats : 1));

  const screenUrl = origin ? origin + '/screen/' + roomId : '';
  const joinUrl = origin ? origin + '/join/' + roomId : '';

  return (
    <section style={panel}>
      <h2 style={panelTitle}>運営操作</h2>
      <p style={panelNote}>
        現在のフェーズで意味のない操作は押せないようにしてあります。
        {state === 'PLAYING' ? 'いまはプレイ中です。リセットは進行中のラウンドを中断します。' : null}
      </p>

      <ControlRow note="待機画面から本番へ。較正 3.2 秒 → カウントダウン 3.5 秒 → プレイ開始。">
        <button
          type="button"
          style={buttonStyle('primary', !canStart)}
          disabled={!canStart}
          onClick={() => send({ type: 'START' })}
        >
          開始
        </button>
      </ControlRow>
      {canStart && readyCount === 0 ? (
        <p style={{ ...rowNote, color: 'var(--lantern)', margin: '-6px 0 0' }}>
          準備できているプレイヤーが 0 人です。無人のまま開始できますが、通常はスマホの接続を待ってください。
        </p>
      ) : null}

      <ControlRow note="どのフェーズからでも待機画面へ戻します。スコアと捕獲数は破棄されます。">
        {confirmReset ? (
          <>
            <span style={{ fontSize: 12, color: 'var(--crimson)', fontWeight: 700, marginRight: 2 }}>
              本当に中断しますか？
            </span>
            <button type="button" style={buttonStyle('danger', false)} onClick={doReset}>
              はい、リセット
            </button>
            <button type="button" style={buttonStyle('normal', false)} onClick={cancelReset}>
              やめる
            </button>
          </>
        ) : (
          <button
            type="button"
            style={buttonStyle('danger', !connected)}
            disabled={!connected}
            onClick={armReset}
          >
            リセット
          </button>
        )}
      </ControlRow>

      <ControlRow note="残り時間を待たずに即座に結果発表へ。プレイ中のみ有効です。">
        <button
          type="button"
          style={buttonStyle('normal', !canSkip)}
          disabled={!canSkip}
          onClick={() => send({ type: 'SKIP_TO_RESULT' })}
        >
          結果へ飛ばす
        </button>
      </ControlRow>

      <ControlRow note="自動で動くダミーのポイを空席に追加します。無人でも画面の見栄えを確認できます。">
        <button
          type="button"
          style={buttonStyle('normal', !canAddBot)}
          disabled={!canAddBot}
          onClick={() => send({ type: 'ADD_BOT', count: addable })}
        >
          ボット追加
        </button>
        <select
          value={botAdd}
          onChange={(e) => setBotAdd(Number(e.currentTarget.value))}
          disabled={!canAddBot}
          style={{
            background: 'var(--night-2)',
            color: 'var(--ink)',
            border: '1px solid rgba(244, 239, 228, 0.16)',
            borderRadius: 5,
            fontSize: 12,
            padding: '8px 6px',
          }}
        >
          {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
            <option key={n} value={n}>
              {n} 体
            </option>
          ))}
        </select>
        <span style={{ fontSize: 11, color: 'var(--ink-dim)' }}>空席 {freeSeats}</span>
      </ControlRow>

      <ControlRow note="追加したボットを全員退席させます。人間のプレイヤーには影響しません。">
        <button
          type="button"
          style={buttonStyle('normal', !canClearBots)}
          disabled={!canClearBots}
          onClick={() => send({ type: 'CLEAR_BOTS' })}
        >
          ボット削除
        </button>
        <span style={{ fontSize: 11, color: 'var(--ink-dim)' }}>現在 {botCount} 体</span>
      </ControlRow>

      <div
        style={{
          marginTop: 14,
          paddingTop: 12,
          borderTop: '1px solid rgba(244, 239, 228, 0.07)',
        }}
      >
        <h3 style={{ ...panelTitle, margin: 0 }}>接続先 URL</h3>
        <p style={{ ...panelNote, margin: '4px 0 0' }}>
          同じ Wi-Fi に繋がった端末から開いてください。ルーム ID は {roomId} です。
        </p>
        <UrlRow label="巨大スクリーン" hint="プロジェクタ用 PC で全画面表示" url={screenUrl} />
        <UrlRow label="参加者スマホ" hint="スクリーンの QR と同じ URL" url={joinUrl} />
      </div>
    </section>
  );
}

export default RoomControls;
