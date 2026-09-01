'use client';

/**
 * The attract / lobby state (spec §19, §132).
 *
 * Someone walks past a five-metre tank full of goldfish and has about four seconds to
 * work out what this is. So: the title, one sentence, a QR they can scan without
 * stopping, and a wordless three-panel diagram of the only three motions in the game.
 * Nobody reads instructions at a festival — they copy a picture.
 *
 * The panel is translucent on purpose. The tank keeps swimming behind it, because the
 * tank IS the advertisement (§99: never a full-screen opaque overlay).
 */

import { GAME, PLAYER_COLOR_NAMES } from '@/game/core/constants';
import { QRPanel } from '@/components/QRPanel';
import type { PlayerPublicState } from '@/types';

export interface WaitingViewProps {
  joinUrl: string;
  players: readonly PlayerPublicState[];
  maxPlayers: number;
  /** Operator控え: 手動でラウンドを開始する。 */
  onStart?: () => void;
  /** 幽霊席を掃除する。 */
  onClearPlayers?: () => void;
}

const STEP_LABEL = ['うごかす', 'しずめる', 'すくい上げる'] as const;
const STEP_SUB = ['画面の左右を押す', '下にかたむける', '上にかたむける'] as const;

/**
 * One panel of the motion diagram. The phone IS the poi, so the drawing shows a phone
 * and the arrow of the motion — no hands, no buttons, nothing to tap.
 */
function MotionStep({ step }: { step: 0 | 1 | 2 }) {
  const accent = 'var(--lantern)';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        flex: '1 1 0',
        minWidth: 128,
      }}
    >
      <svg viewBox="0 0 120 120" width="100%" height="118" role="img" aria-label={STEP_LABEL[step]}>
        <defs>
          <linearGradient id={`kingyo-water-${step}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2fa2b8" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#123b52" stopOpacity="0.15" />
          </linearGradient>
        </defs>

        {/* the water — the same line in all three panels, so the phone reads as moving */}
        <rect x="6" y="70" width="108" height="42" rx="8" fill={`url(#kingyo-water-${step})`} />
        <path
          d="M6 72 q 13 -6 27 0 t 27 0 t 27 0 t 27 0"
          fill="none"
          stroke="#7fd8e6"
          strokeWidth="2.2"
          strokeLinecap="round"
          opacity="0.8"
        />

        {step === 0 ? (
          /* うごかす: press toward an edge of the screen — the phone stays level */
          <g transform="translate(60 40)">
            <rect x="-15" y="-27" width="30" height="54" rx="7" fill="#f4efe4" stroke="#0b0d18" strokeWidth="2.4" />
            <rect x="-10" y="-21" width="20" height="38" rx="3" fill="#2a3352" />
            {/* the pressing finger, right half, with touch ripples */}
            <circle cx="5.5" cy="0" r="4.6" fill={accent} />
            <circle cx="5.5" cy="0" r="9" fill="none" stroke={accent} strokeWidth="1.6" opacity="0.55" />
            <circle cx="5.5" cy="0" r="13.5" fill="none" stroke={accent} strokeWidth="1.2" opacity="0.28" />
            {/* the chevrons the player will see in play */}
            <path d="M25 -9 l 8 9 l -8 9" fill="none" stroke={accent} strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M-25 -9 l -8 9 l 8 9" fill="none" stroke={accent} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" opacity="0.3" />
          </g>
        ) : null}

        {step === 1 ? (
          /* しずめる: TILT the phone nose-down — the rotation is the action */
          <g transform="translate(60 46)">
            <rect x="-15" y="-27" width="30" height="54" rx="7" fill="none" stroke="#f4efe4" strokeWidth="2" strokeDasharray="4 5" opacity="0.3" />
            <g transform="rotate(40)">
              <rect x="-15" y="-27" width="30" height="54" rx="7" fill="#f4efe4" stroke="#0b0d18" strokeWidth="2.4" />
              <rect x="-10" y="-21" width="20" height="38" rx="3" fill="#2a3352" />
            </g>
            <path d="M22 -34 a 26 26 0 0 1 13 24" fill="none" stroke={accent} strokeWidth="3.2" strokeLinecap="round" />
            <path d="M36 -2 l -8 -8.5 l 12 -2.5 z" fill={accent} />
          </g>
        ) : null}

        {step === 2 ? (
          /* すくい上げる: tilt it back up — the fish clears the water */
          <g transform="translate(60 48)">
            <g transform="rotate(40)">
              <rect x="-15" y="-27" width="30" height="54" rx="7" fill="none" stroke="#f4efe4" strokeWidth="2" strokeDasharray="4 5" opacity="0.3" />
            </g>
            <g transform="rotate(-28)">
              <rect x="-15" y="-27" width="30" height="54" rx="7" fill="#f4efe4" stroke="#0b0d18" strokeWidth="2.4" />
              <rect x="-10" y="-21" width="20" height="38" rx="3" fill="#2a3352" />
            </g>
            {/* the catch */}
            <g transform="translate(26 -38)">
              <circle cx="0" cy="0" r="7" fill="#e2472c" />
              <path d="M6 0 l 8 -5 0 10 z" fill="#ff7a52" />
            </g>
            <path d="M38 10 a 30 30 0 0 0 -10 -32" fill="none" stroke={accent} strokeWidth="3.2" strokeLinecap="round" />
            <path d="M26 -25 l 12 1 l -6.5 10 z" fill={accent} />
          </g>
        ) : null}
      </svg>

      <div style={{ textAlign: 'center' }}>
        <div
          className="jp-title"
          style={{ fontSize: 'clamp(16px, 1.5vw, 26px)', color: 'var(--ink)', letterSpacing: '0.06em' }}
        >
          <span style={{ color: accent, marginRight: 8 }}>{step + 1}</span>
          {STEP_LABEL[step]}
        </div>
        <div style={{ fontSize: 12, color: 'var(--ink-dim)', marginTop: 3 }}>{STEP_SUB[step]}</div>
      </div>
    </div>
  );
}

function PlayerChip({ p }: { p: PlayerPublicState }) {
  const name = PLAYER_COLOR_NAMES[(p.number - 1) % PLAYER_COLOR_NAMES.length];
  const status = !p.connected
    ? '切断'
    : p.spectating
      ? '次のゲームから'
      : p.controllerReady
        ? '準備OK'
        : 'センサー待ち';

  return (
    <div
      className="fade-in"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '7px 14px 8px',
        borderRadius: 999,
        background: 'rgba(7,8,15,0.6)',
        boxShadow: `inset 0 0 0 1px ${p.color}66`,
        opacity: p.connected ? 1 : 0.5,
      }}
    >
      <span
        className="tabular"
        style={{ color: p.color, fontWeight: 700, fontSize: 16, letterSpacing: '0.05em' }}
      >
        P{p.number}
      </span>
      <span style={{ color: 'var(--ink)', fontSize: 14 }}>{name}</span>
      <span
        style={{
          fontSize: 12,
          color: p.controllerReady && p.connected && !p.spectating ? '#7ddc9a' : 'var(--ink-dim)',
        }}
      >
        {status}
      </span>
    </div>
  );
}

export function WaitingView({
  joinUrl,
  players,
  maxPlayers,
  onStart,
  onClearPlayers,
}: WaitingViewProps) {
  const seated = players.filter((p) => !p.spectating);
  const ready = seated.filter((p) => p.connected && p.controllerReady).length;
  const cap = Math.max(1, Math.min(maxPlayers || GAME.maxPlayers, GAME.hardMaxPlayers));

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
        className="fade-in"
        style={{
          width: 'min(1180px, 82vw)',
          maxHeight: '92vh',
          padding: 'clamp(20px, 2.6vh, 38px) clamp(24px, 3vw, 52px)',
          borderRadius: 22,
          background:
            'linear-gradient(160deg, rgba(10,12,24,0.80), rgba(7,8,15,0.72) 60%, rgba(10,12,24,0.80))',
          backdropFilter: 'blur(9px)',
          WebkitBackdropFilter: 'blur(9px)',
          boxShadow: '0 24px 90px rgba(0,0,0,0.65), inset 0 0 0 1px rgba(255,182,77,0.22)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'clamp(14px, 2vh, 26px)',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <h1
            className="jp-title"
            style={{
              margin: 0,
              fontSize: 'clamp(38px, 5.2vw, 92px)',
              lineHeight: 1.05,
              color: 'var(--lantern)',
              textShadow: '0 0 60px rgba(226,97,43,0.45), 0 6px 24px rgba(0,0,0,0.8)',
            }}
          >
            巨大デジタル金魚すくい
          </h1>
          <p
            className="jp-title"
            style={{
              margin: '10px 0 0',
              fontSize: 'clamp(17px, 1.9vw, 32px)',
              color: 'var(--ink)',
              letterSpacing: '0.1em',
            }}
          >
            スマホをポイにして遊ぼう！
          </p>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 'clamp(18px, 3vw, 54px)',
            alignItems: 'center',
            justifyContent: 'center',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <QRPanel url={joinUrl} size={230} />
            <div
              style={{
                fontSize: 13,
                color: 'var(--ink-dim)',
                letterSpacing: '0.1em',
                textAlign: 'center',
              }}
            >
              QRを読みこんで、
              <span style={{ color: 'var(--lantern)' }}>「参加する」</span>
              をタップ
            </div>
          </div>

          <div style={{ flex: '1 1 420px', minWidth: 340, maxWidth: 620 }}>
            <div
              style={{
                fontSize: 12,
                letterSpacing: '0.3em',
                color: 'var(--ink-dim)',
                marginBottom: 10,
                textAlign: 'center',
              }}
            >
              あそびかた
            </div>
            <div style={{ display: 'flex', gap: 'clamp(6px, 1.2vw, 20px)', alignItems: 'flex-start' }}>
              <MotionStep step={0} />
              <MotionStep step={1} />
              <MotionStep step={2} />
            </div>
            <div
              style={{
                marginTop: 12,
                textAlign: 'center',
                fontSize: 13,
                color: 'var(--ink-dim)',
                lineHeight: 1.7,
              }}
            >
              スマホを下にかたむけて水へ、上にかたむけてすくう。移動は画面の左右を押すだけ。
              <br />
              勢いよく返すと、本物と同じように紙がやぶれます。
            </div>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 'clamp(14px, 2.4vw, 34px)',
            flexWrap: 'wrap',
            paddingTop: 'clamp(6px, 1.4vh, 16px)',
            borderTop: '1px solid rgba(255,255,255,0.10)',
          }}
        >
          <div
            className="tabular"
            style={{
              fontSize: 'clamp(22px, 2.4vw, 40px)',
              fontWeight: 700,
              letterSpacing: '0.1em',
              color: seated.length > 0 ? 'var(--ink)' : 'var(--ink-dim)',
              whiteSpace: 'nowrap',
            }}
          >
            {seated.length} / {cap}
            <span style={{ fontSize: '0.5em', marginLeft: 10, letterSpacing: '0.28em' }}>PLAYERS</span>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
            {players.length === 0 ? (
              <span style={{ color: 'var(--ink-dim)', fontSize: 14 }}>
                さいしょのプレイヤーを待っています…
              </span>
            ) : (
              players
                .slice()
                .sort((a, b) => a.number - b.number)
                .map((p) => <PlayerChip key={p.id} p={p} />)
            )}
          </div>

          {/*
            Operator controls. The projector machine has a keyboard and mouse;
            the audience does not. Normally the room starts itself once players
            are ready, but staff need to be able to start a round on cue — and to
            clear a seat left behind by a browser tab nobody can find any more.

            pointerEvents is re-enabled here only: the rest of the overlay stays
            transparent to input so it can never sit between anyone and the tank.
          */}
          {(onStart || onClearPlayers) && (
            <div
              style={{
                marginTop: 'clamp(14px, 1.8vh, 26px)',
                display: 'flex',
                gap: 12,
                justifyContent: 'center',
                alignItems: 'center',
                flexWrap: 'wrap',
                pointerEvents: 'auto',
              }}
            >
              {onStart && (
                <button
                  type="button"
                  onClick={onStart}
                  disabled={seated.length === 0}
                  title="スペースキーでも開始できます"
                  style={{
                    minWidth: 190,
                    padding: '13px 30px 14px',
                    border: 'none',
                    borderRadius: 12,
                    cursor: seated.length === 0 ? 'not-allowed' : 'pointer',
                    background:
                      seated.length === 0
                        ? 'rgba(255,255,255,0.07)'
                        : 'linear-gradient(170deg, var(--lantern, #ffb64d) 0%, var(--lantern-deep, #e2612b) 100%)',
                    color: seated.length === 0 ? 'rgba(226,238,248,0.35)' : '#20120a',
                    fontFamily: 'var(--font-ui, system-ui, sans-serif)',
                    fontSize: 20,
                    fontWeight: 900,
                    letterSpacing: '0.2em',
                    textIndent: '0.2em',
                  }}
                >
                  START
                </button>
              )}

              {onClearPlayers && players.length > 0 && (
                <button
                  type="button"
                  onClick={onClearPlayers}
                  style={{
                    padding: '12px 20px',
                    borderRadius: 12,
                    border: '1px solid rgba(226,238,248,0.22)',
                    background: 'transparent',
                    color: 'rgba(226,238,248,0.62)',
                    fontFamily: 'var(--font-ui, system-ui, sans-serif)',
                    fontSize: 13,
                    fontWeight: 700,
                    letterSpacing: '0.1em',
                    cursor: 'pointer',
                  }}
                >
                  全員退出
                </button>
              )}

              <span
                style={{
                  fontSize: 11.5,
                  letterSpacing: '0.08em',
                  color: 'rgba(169,160,143,0.55)',
                }}
              >
                {seated.length === 0
                  ? 'スマホが1台つながると開始できます'
                  : `準備できた人 ${ready} / ${seated.length}　·　スペースキーで開始`}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default WaitingView;
