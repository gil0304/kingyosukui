'use client';

/**
 * The first thing a player sees after scanning the QR code (spec §20).
 *
 * One tap, and only one tap, exists in this entire installation — right here.
 * It is not a game control: iOS 13 and later will only hand over
 * DeviceOrientation and DeviceMotion from inside a genuine user gesture, so the
 * permission request has to be attached to a real button. That is the whole
 * reason this screen exists. After this tap the phone stops being a touchscreen
 * and becomes a poi (spec §23).
 *
 * Because the request must originate in the gesture, the 'join' prop is called
 * synchronously from onClick — never after an await, never from an effect, never
 * from a timeout. Anything else and iOS silently refuses.
 *
 * The secure-context warning is not decoration either. Motion sensors are
 * unavailable over plain http, so a phone that reached this page through an
 * http:// URL will tap the button, be told nothing by the browser, and simply
 * never move a poi. Better to say so before the tap than after it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import {
  detectMotionCapabilities,
  type MotionCapabilities,
} from '@/controller/sensors/permission';
import { HowToPlay } from './HowToPlay';

export interface JoinGateProps {
  /** Shown so staff can confirm the phone reached the right tank. */
  roomId: string;
  /**
   * Starts the permission request and the join. MUST be safe to call directly
   * inside the click handler — it is.
   */
  join: () => void;
}

const WARN_BOX: CSSProperties = {
  padding: '11px 14px',
  borderRadius: 12,
  fontSize: 13,
  lineHeight: 1.6,
  textAlign: 'left',
};

export function JoinGate({ roomId, join }: JoinGateProps) {
  // Probed after mount: 'window' does not exist while this renders on the server.
  const [caps, setCaps] = useState<MotionCapabilities | null>(null);
  const [pressed, setPressed] = useState(false);
  const firedRef = useRef(false);

  /**
   * The tap is fired from pointerup as well as click.
   *
   * A phone that never delivers a synthetic click — a stray pixel of movement
   * turning the tap into a pan, a browser suppressing click under a
   * touch-action rule, an iOS quirk — leaves the player pressing a button that
   * does nothing, with no way into the piece at all. pointerup is a valid user
   * activation for the iOS permission prompt, so raising the flow from it loses
   * nothing, and the guard keeps the two paths from joining twice.
   */
  const fire = useCallback(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    // Released so a failed attempt can be retried, but not so fast that the
    // click following a pointerup counts as a second press.
    window.setTimeout(() => {
      firedRef.current = false;
    }, 1500);
    join();
  }, [join]);
  useEffect(() => {
    setCaps(detectMotionCapabilities());
  }, []);

  const insecure = caps !== null && !caps.secureContext;
  const noSensors = caps !== null && !caps.hasOrientation && !caps.hasMotion;

  return (
    <div
      className="fade-in"
      style={{
        flex: 1,
        minHeight: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        padding:
          'calc(env(safe-area-inset-top, 0px) + 20px) calc(env(safe-area-inset-right, 0px) + 20px) calc(env(safe-area-inset-bottom, 0px) + 18px) calc(env(safe-area-inset-left, 0px) + 20px)',
        background:
          'radial-gradient(130% 74% at 50% 0%, rgba(35,30,62,0.95) 0%, rgba(10,12,24,1) 62%, rgba(5,6,12,1) 100%)',
        color: 'var(--ink, #f4efe4)',
        fontFamily: 'var(--font-ui, system-ui, sans-serif)',
        overflow: 'hidden',
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}
    >
      <style>
        {'@keyframes kgs-join-glow{0%,100%{box-shadow:0 0 0 rgba(255,182,77,0),0 10px 30px rgba(0,0,0,0.45)}50%{box-shadow:0 0 34px rgba(255,182,77,0.45),0 10px 30px rgba(0,0,0,0.45)}}'}
      </style>

      {/* --- title ---------------------------------------------------------- */}
      <div style={{ textAlign: 'center' }}>
        <h1
          className="jp-title"
          style={{
            margin: 0,
            fontSize: 'clamp(23px, 7.4vw, 34px)',
            lineHeight: 1.22,
            fontWeight: 700,
            color: 'var(--lantern, #ffb64d)',
            textShadow: '0 0 26px rgba(255,182,77,0.34)',
          }}
        >
          巨大デジタル金魚すくい
        </h1>
        <p
          style={{
            margin: '10px 0 0',
            fontSize: 'clamp(14px, 4.2vw, 17px)',
            lineHeight: 1.6,
            color: 'rgba(226,238,248,0.9)',
          }}
        >
          スマホをポイのように持って遊びます。
        </p>
        <div
          style={{
            marginTop: 10,
            display: 'inline-block',
            padding: '5px 12px 6px',
            borderRadius: 999,
            border: '1px solid rgba(255,182,77,0.3)',
            fontSize: 12,
            fontWeight: 800,
            letterSpacing: '0.16em',
            color: 'var(--ink-dim, #a9a08f)',
          }}
        >
          水槽 <span className="tabular">{roomId.toUpperCase()}</span>
        </div>
      </div>

      {/* --- warnings that must be read BEFORE the tap ---------------------- */}
      {insecure && (
        <div
          style={{
            ...WARN_BOX,
            background: 'rgba(200,53,42,0.16)',
            border: '1px solid rgba(224,72,58,0.55)',
            color: '#ffd0c6',
          }}
        >
          <strong style={{ display: 'block', marginBottom: 4, fontSize: 14 }}>
            HTTPS で開いてください
          </strong>
          スマホのモーションセンサーは、安全な接続（https）でないと利用できません。
          スクリーンのQRコードから開き直してください。
        </div>
      )}

      {!insecure && noSensors && (
        <div
          style={{
            ...WARN_BOX,
            background: 'rgba(232,195,60,0.12)',
            border: '1px solid rgba(232,195,60,0.42)',
            color: '#f3e3ac',
          }}
        >
          この端末ではモーションセンサーが見つかりませんでした。スマートフォンでお試しください。
        </div>
      )}

      {/* --- the one and only tap ------------------------------------------ */}
      <button
        type="button"
        // The boot sentinel (src/app/boot.ts) matches this id to answer taps
        // that arrive before React does.
        id="join-button"
        onClick={fire}
        // Pointer events fire before the click, so the button visibly reacts the
        // instant a finger lands rather than after the permission sheet appears.
        onPointerDown={() => setPressed(true)}
        onPointerUp={() => {
          setPressed(false);
          fire();
        }}
        onPointerCancel={() => setPressed(false)}
        style={{
          flexShrink: 0,
          width: '100%',
          minHeight: 78,
          // Brightness only, never a transform: shrinking the element under a
          // finger can move its edge out from under the touch and lose the tap.
          filter: pressed ? 'brightness(0.88)' : 'none',
          transition: 'filter 90ms ease-out',
          border: 'none',
          borderRadius: 18,
          // Fallbacks are deliberate: with no palette at all this still renders
          // as a solid orange button rather than an invisible dark rectangle.
          background:
            'linear-gradient(170deg, var(--lantern, #ffb64d) 0%, var(--lantern-deep, #e2612b) 100%)',
          backgroundColor: '#ffb64d',
          color: '#20120a',
          fontFamily: 'var(--font-ui, system-ui, sans-serif)',
          fontSize: 'clamp(24px, 7vw, 30px)',
          fontWeight: 900,
          letterSpacing: '0.24em',
          textIndent: '0.24em',
          cursor: 'pointer',
          WebkitTapHighlightColor: 'transparent',
          touchAction: 'manipulation',
          animation: 'kgs-join-glow 2.4s ease-in-out infinite',
        }}
      >
        参加する
      </button>

      <div
        style={{
          fontSize: 12.5,
          lineHeight: 1.6,
          textAlign: 'center',
          color: 'var(--ink-dim, #a9a08f)',
          marginTop: -4,
        }}
      >
        タップすると、動きのセンサーの許可を求められます。
        <br />
        「許可」を選んでください。
      </div>

      {/* --- how to play ----------------------------------------------------
          The ONLY part allowed to give way. Short phones (and phones whose
          browser chrome eats 150 px of viewport) used to push the button off
          the bottom of a clipped, unscrollable column: the one tap in the whole
          installation became unreachable. The instructions scroll instead. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
          // Scrolling the pre-game instructions is not a game control (§23);
          // the no-touch rule starts once the poi exists.
          touchAction: 'pan-y',
          overscrollBehavior: 'contain',
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 800,
            letterSpacing: '0.24em',
            color: 'rgba(198,216,232,0.62)',
            marginBottom: 9,
            textAlign: 'center',
          }}
        >
          あそびかた
        </div>
        <HowToPlay variant="full" />

        <div
          style={{
            marginTop: 14,
            fontSize: 12.5,
            lineHeight: 1.6,
            textAlign: 'center',
            color: 'rgba(169,160,143,0.8)',
          }}
        >
          かたむきがポイの動きに。移動だけ画面の左右を押します。
        </div>

        {/*
          A one-line, honest report of what this particular phone can actually
          do. At a venue it lets staff triage a phone in three seconds instead of
          guessing; while developing it is the difference between "it does not
          work" and a fault anyone can act on.
        */}
        <div
          style={{
            marginTop: 12,
            fontSize: 10.5,
            letterSpacing: '0.06em',
            textAlign: 'center',
            color: 'rgba(140,152,170,0.62)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {caps === null
            ? 'この端末を確認しています…'
            : [
                caps.secureContext ? 'https OK' : 'https ✗',
                caps.hasOrientation ? '傾き OK' : '傾き ✗',
                caps.hasMotion ? '加速度 OK' : '加速度 ✗',
                caps.needsPermission ? '許可ダイアログ あり' : '許可ダイアログ なし',
              ].join(' · ')}
        </div>
      </div>
    </div>
  );
}
