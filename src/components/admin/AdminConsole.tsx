'use client';

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { PlayerTable, isBotPlayer } from '@/components/admin/PlayerTable';
import { RoomControls } from '@/components/admin/RoomControls';
import { SettingsPanel } from '@/components/admin/SettingsPanel';
import { GAME } from '@/game/core/constants';
import { useAdminSocket } from '@/network/socket/useAdminSocket';
import type { RoomPublicState, RoomState } from '@/types';

export interface AdminConsoleProps {
  roomId: string;
  /** Called when the operator switches to another room from the header. */
  onRoomIdChange?: (roomId: string) => void;
}

const STATE_LABEL: Record<RoomState, string> = {
  WAITING: '待機中',
  CALIBRATION: '較正中',
  COUNTDOWN: 'カウントダウン',
  PLAYING: 'プレイ中',
  RESULT: '結果発表',
};

const STATE_TONE: Record<RoomState, string> = {
  WAITING: 'var(--ink-dim)',
  CALIBRATION: 'var(--water)',
  COUNTDOWN: 'var(--lantern)',
  PLAYING: '#8ee6a1',
  RESULT: 'var(--gold)',
};

/**
 * Seconds left in the current phase, recomputed locally from the server clock so the
 * number keeps moving between room broadcasts. Null when the phase is open-ended.
 */
function usePhaseClock(room: RoomPublicState | null): number | null {
  const offsetRef = useRef(0);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!room) return;
    offsetRef.current = room.serverTime - Date.now();
  }, [room]);

  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => (n + 1) % 1000), 200);
    return () => window.clearInterval(id);
  }, []);

  if (!room || room.phaseEndsAt === null) return null;
  const remaining = (room.phaseEndsAt - (Date.now() + offsetRef.current)) / 1000;
  return remaining > 0 ? remaining : 0;
}

function formatRemaining(seconds: number): string {
  if (seconds < 10) return seconds.toFixed(1);
  const whole = Math.ceil(seconds);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function Pill({
  label,
  value,
  tone,
  pulse,
}: {
  label: string;
  value: string;
  tone: string;
  pulse?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '6px 12px',
        borderRadius: 6,
        background: 'var(--night-1)',
        border: '1px solid rgba(244, 239, 228, 0.10)',
        minWidth: 96,
      }}
    >
      <span style={{ fontSize: 9, letterSpacing: '0.16em', color: 'rgba(169, 160, 143, 0.8)' }}>
        {label}
      </span>
      <span
        style={{
          fontSize: 14,
          fontWeight: 700,
          letterSpacing: '0.04em',
          color: tone,
          animation: pulse ? 'kingyo-pulse 1.1s ease-in-out infinite' : undefined,
        }}
      >
        {value}
      </span>
    </div>
  );
}

function RoomSwitcher({
  roomId,
  onRoomIdChange,
}: {
  roomId: string;
  onRoomIdChange?: (roomId: string) => void;
}) {
  const [draft, setDraft] = useState(roomId);

  useEffect(() => {
    setDraft(roomId);
  }, [roomId]);

  if (!onRoomIdChange) return null;

  const normalized = draft.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const changed = normalized.length > 0 && normalized !== roomId;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (changed) onRoomIdChange(normalized);
      }}
      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
    >
      <input
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        aria-label="ルーム ID"
        spellCheck={false}
        autoCapitalize="characters"
        className="tabular"
        style={{
          width: 132,
          background: 'var(--night-0)',
          border: '1px solid rgba(244, 239, 228, 0.16)',
          borderRadius: 5,
          color: 'var(--ink)',
          fontSize: 12,
          letterSpacing: '0.08em',
          padding: '7px 8px',
        }}
      />
      <button
        type="submit"
        disabled={!changed}
        style={{
          appearance: 'none',
          padding: '7px 11px',
          borderRadius: 5,
          background: 'var(--night-2)',
          border: '1px solid rgba(244, 239, 228, 0.16)',
          color: 'var(--ink)',
          fontFamily: 'var(--font-ui)',
          fontSize: 12,
          fontWeight: 700,
          cursor: changed ? 'pointer' : 'not-allowed',
          opacity: changed ? 1 : 0.34,
        }}
      >
        切替
      </button>
    </form>
  );
}

function Banner({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: '10px 14px',
        borderRadius: 6,
        background: 'rgba(200, 53, 42, 0.18)',
        border: '1px solid rgba(200, 53, 42, 0.55)',
        color: '#ffc9c2',
        fontSize: 13,
        lineHeight: 1.6,
      }}
    >
      {children}
    </div>
  );
}

const shell: CSSProperties = {
  // globals.css pins "main" to height 100%; the console is a scrolling utility page.
  height: 'auto',
  minHeight: '100vh',
  background: 'var(--night-0)',
  color: 'var(--ink)',
  padding: '18px 20px 40px',
};

export function AdminConsole({ roomId, onRoomIdChange }: AdminConsoleProps) {
  const { connected, room, send } = useAdminSocket(roomId);
  const remaining = usePhaseClock(room);

  const players = room?.players ?? [];
  const state: RoomState = room?.state ?? 'WAITING';
  const maxPlayers = room?.settings.maxPlayers ?? GAME.maxPlayers;
  const botCount = players.filter(isBotPlayer).length;
  const readyCount = players.filter((p) => p.connected && p.controllerReady).length;
  const freeSeats = Math.max(0, maxPlayers - players.length);
  const waitingCount = room?.waitingPlayers.length ?? 0;

  return (
    <main style={shell}>
      <header style={{ maxWidth: 1560, margin: '0 auto 16px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <h1
              className="jp-title"
              style={{ margin: 0, fontSize: 20, fontWeight: 400, color: 'var(--lantern)' }}
            >
              巨大デジタル金魚すくい — 運営コンソール
            </h1>
            <div
              className="tabular"
              style={{ marginTop: 5, fontSize: 12, color: 'var(--ink-dim)', letterSpacing: '0.06em' }}
            >
              ルーム {roomId}
              {waitingCount > 0 ? (
                <span style={{ marginLeft: 12, color: 'var(--lantern)' }}>
                  次ラウンド待ち {waitingCount} 人
                </span>
              ) : null}
            </div>
          </div>
          <RoomSwitcher roomId={roomId} onRoomIdChange={onRoomIdChange} />
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
          <Pill
            label="サーバー"
            value={connected ? '接続済' : '切断'}
            tone={connected ? '#8ee6a1' : 'var(--crimson)'}
            pulse={!connected}
          />
          <Pill
            label="スクリーン"
            value={room?.screenConnected ? '表示中' : '未接続'}
            tone={room?.screenConnected ? '#8ee6a1' : 'var(--lantern)'}
            pulse={room !== null && !room.screenConnected}
          />
          <Pill label="フェーズ" value={STATE_LABEL[state]} tone={STATE_TONE[state]} />
          <Pill
            label="残り時間"
            value={remaining === null ? '—' : formatRemaining(remaining)}
            tone={remaining !== null && remaining <= 10 ? 'var(--crimson)' : 'var(--ink)'}
          />
          <Pill
            label="参加者"
            value={readyCount + ' / ' + players.length + ' 人'}
            tone={players.length > 0 ? 'var(--ink)' : 'var(--ink-dim)'}
          />
        </div>

        <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
          {!connected ? (
            <Banner>
              サーバーに接続できていません。表示中の値は最後に受信した内容です。
              操作は届きません。サーバープロセスと LAN を確認してください（自動で再接続を試み続けます）。
            </Banner>
          ) : null}
          {connected && room !== null && !room.screenConnected ? (
            <Banner>
              巨大スクリーンが接続されていません。プロジェクタ用 PC で
              スクリーン URL を開いて全画面にしてください。
            </Banner>
          ) : null}
        </div>
      </header>

      <div
        style={{
          maxWidth: 1560,
          margin: '0 auto',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
          gap: 16,
        }}
      >
        <div
          style={{
            flex: '1 1 380px',
            minWidth: 330,
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <RoomControls
            roomId={roomId}
            state={state}
            connected={connected}
            readyCount={readyCount}
            botCount={botCount}
            freeSeats={freeSeats}
            send={send}
          />
          <SettingsPanel
            settings={room?.settings ?? null}
            state={state}
            connected={connected}
            send={send}
          />
        </div>

        <div style={{ flex: '2 1 620px', minWidth: 330 }}>
          <PlayerTable
            players={players}
            maxPlayers={maxPlayers}
            connected={connected}
            send={send}
          />
        </div>
      </div>
    </main>
  );
}

export default AdminConsole;
