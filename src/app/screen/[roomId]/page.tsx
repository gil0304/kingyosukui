'use client';

/**
 * The giant screen (spec §99–§102).
 *
 * One room, one tank, one projector. The canvas fills the viewport and the entire HUD is
 * a DOM overlay pinned to the edges — see 'ScreenHud'. Nothing here owns game state: the
 * server is authoritative, this page renders what it is told and plays the effects.
 *
 * The 3D canvas is mounted only after the component is on the client. There is nothing to
 * server-render inside a WebGL context, and the projector machine's device pixel ratio —
 * which decides the render resolution — cannot be known until then.
 */

import { Canvas } from '@react-three/fiber';
import { use, useCallback, useEffect, useState } from 'react';
import * as THREE from 'three';

import { audio } from '@/audio/AudioEngine';
import { buildJoinUrl } from '@/components/QRPanel';
import { DebugOverlay } from '@/components/screen/DebugOverlay';
import { FrameHealthProbe, FrameHealthReadout } from '@/components/screen/FrameHealth';
import { ScreenHud, useServerClock } from '@/components/screen/ScreenHud';
import { TankScene } from '@/game/TankScene';
import { useScreenSocket } from '@/network/socket/useScreenSocket';

/**
 * Render resolution ceiling (spec §77). 1.5 keeps the water shader honest on a laptop
 * GPU; anything wider than 2560 is a 4K projector or a video wall, where a full-res
 * water pass plus a refraction FBO is simply not affordable and 1.0 still looks superb
 * at that pixel count.
 */
function computeDpr(): number {
  if (typeof window === 'undefined') return 1;
  const device = Math.min(window.devicePixelRatio || 1, 1.5);
  return window.innerWidth > 2560 ? Math.min(device, 1) : device;
}

interface WakeLockSentinelLike {
  release(): Promise<void>;
}

interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

/** Keeps the projector machine from blanking mid-show. Best effort, never fatal. */
function useScreenWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === 'undefined') return undefined;

    const api = (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock;
    if (!api) return undefined;

    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;

    const acquire = () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      api
        .request('screen')
        .then((s) => {
          if (cancelled) void s.release().catch(() => undefined);
          else sentinel = s;
        })
        .catch(() => undefined);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !sentinel) acquire();
    };

    acquire();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (sentinel) void sentinel.release().catch(() => undefined);
      sentinel = null;
    };
  }, [active]);
}

export default function ScreenPage({ params }: { params: Promise<{ roomId: string }> }) {
  // Next has already decoded the segment; decoding again would corrupt any id
  // containing a literal percent sign.
  const { roomId } = use(params);

  const api = useScreenSocket(roomId);
  const { room } = api;

  const [mounted, setMounted] = useState(false);
  const [dpr, setDpr] = useState(1);
  const [debug, setDebug] = useState(false);
  const [joinUrl, setJoinUrl] = useState(`/join/${roomId}`);
  const [audioReady, setAudioReady] = useState(false);

  const clock = useServerClock(room?.serverTime);

  const settings = room?.settings;
  const highQuality = settings?.highQuality ?? true;
  const audioEnabled = settings?.audioEnabled ?? true;
  const breakPenalty = settings?.poiBreakPenalty ?? true;

  useScreenWakeLock(mounted);

  // ---------------------------------------------------------------- client boot
  useEffect(() => {
    setMounted(true);
    setDpr(computeDpr());
    setDebug(new URLSearchParams(window.location.search).get('debug') === '1');
    setJoinUrl(buildJoinUrl(roomId));

    let frame = 0;
    const onResize = () => {
      // Coalesced: a projector being re-detected fires a burst of resize events.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = computeDpr();
        setDpr((current) => (Math.abs(current - next) < 0.01 ? current : next));
      });
    };

    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
    };
  }, [roomId]);

  // -------------------------------------------------------------------- audio
  useEffect(() => {
    audio.engine.setEnabled(audioEnabled);
  }, [audioEnabled]);

  const unlockAudio = useCallback(() => {
    if (!audioEnabled) return;
    void audio.resume().then(() => {
      if (!audio.engine.ready) return;
      audio.engine.startAmbience();
      setAudioReady(true);
    });
  }, [audioEnabled]);

  const needsAudioGesture = mounted && audioEnabled && !audioReady && audio.engine.available;

  return (
    <main
      className="screen-root"
      onPointerDown={needsAudioGesture ? unlockAudio : undefined}
      style={{ cursor: needsAudioGesture ? 'pointer' : 'none' }}
    >
      {mounted ? (
        <Canvas
          dpr={dpr}
          // 'percentage' = PCFShadowMap. three deprecated PCFSoftShadowMap, which is
          // what a bare shadows={true} still selects, so it is named explicitly.
          shadows="percentage"
          frameloop="always"
          gl={{
            antialias: true,
            powerPreference: 'high-performance',
            alpha: false,
            stencil: false,
          }}
          camera={{ position: [0, 4.35, 9.15], fov: 42, near: 0.1, far: 140 }}
          onCreated={({ gl }) => {
            // Summer night (spec §64): filmic roll-off, and deliberately under-exposed
            // so the lanterns and the gold fish are the only things near clipping.
            gl.toneMapping = THREE.ACESFilmicToneMapping;
            gl.toneMappingExposure = 0.86;
            gl.setClearColor(new THREE.Color('#05060c'), 1);
          }}
          style={{ position: 'absolute', inset: 0, display: 'block' }}
        >
          <TankScene api={api} highQuality={highQuality} breakPenalty={breakPenalty} />
          {/* Black-flash detective: continuous black-frame surveillance with
              event correlation (console + debug overlay). Debug-only — its
              per-frame readPixels is a pipeline sync the show can live without. */}
          {debug ? <FrameHealthProbe api={api} /> : null}
        </Canvas>
      ) : null}

      <ScreenHud api={api} roomId={roomId} joinUrl={joinUrl} clock={clock} />

      {needsAudioGesture ? (
        <button
          type="button"
          onClick={unlockAudio}
          className="fade-in"
          style={{
            position: 'absolute',
            right: 'clamp(16px, 1.9vw, 40px)',
            bottom: 'clamp(16px, 1.9vw, 40px)',
            zIndex: 30,
            pointerEvents: 'auto',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: '9px 16px 10px',
            borderRadius: 999,
            border: 'none',
            background: 'rgba(7,8,15,0.78)',
            boxShadow: 'inset 0 0 0 1px rgba(255,182,77,0.4)',
            color: 'var(--ink)',
            font: 'inherit',
            fontSize: 13,
            letterSpacing: '0.08em',
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 9h4l5-4v14l-5-4H4z" fill="var(--lantern)" />
            <path
              d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"
              fill="none"
              stroke="var(--lantern)"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
          クリックで音を有効化
        </button>
      ) : null}

      {debug ? (
        <DebugOverlay
          room={api.room}
          phase={api.phase}
          connected={api.connected}
          fishBuffer={api.fishBuffer}
          poiBuffer={api.poiBuffer}
          clock={clock}
        />
      ) : null}
    </main>
  );
}
