'use client';

/**
 * The player's own goldfish bowl, on their own phone (spec §86-§93).
 *
 * Owns exactly one 'BowlSimulation' and one 2D canvas: device-pixel-ratio aware
 * (capped at 2 so a 3x phone does not burn its battery on a decorative bowl),
 * resized by a 'ResizeObserver', driven by 'requestAnimationFrame', and paused
 * whenever the document is hidden.
 *
 * There is nothing interactive here. Touching this canvas does nothing — spec
 * §23 forbids the phone from having any control affordance at all.
 */

import { useEffect, useRef, type CSSProperties } from 'react';
import type { CapturedFish } from '@/types';
import { BowlSimulation, type BowlBounds } from './bowlSimulation';
import { drawBowl } from './bowlFishRenderer';

export interface BowlCanvasProps {
  /** The server's authoritative list of what this player has scooped. */
  capturedFish: readonly CapturedFish[];
  /** Live phone roll (gamma) in RADIANS. Tilts the water surface only (§93). */
  tilt?: number;
  className?: string;
  style?: CSSProperties;
}

/** Never render the bowl at more than 2x — phones are 3x and it is not worth it. */
const MAX_DPR = 2;

const computeBounds = (w: number, h: number): BowlBounds => {
  const rx = Math.min(w * 0.47, h * 0.44);
  const ry = rx * 0.94;
  const cy = h * 0.5;
  return {
    cx: w / 2,
    cy,
    rx,
    ry,
    // Roughly two thirds full: enough water to swim in, enough glass to see.
    waterY: cy - ry * 0.52,
  };
};

export function BowlCanvas({ capturedFish, tilt = 0, className, style }: BowlCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const simRef = useRef<BowlSimulation | null>(null);
  if (simRef.current === null) simRef.current = new BowlSimulation();

  // Props are read from the animation loop, so they live in refs rather than
  // re-subscribing the loop on every render.
  const fishRef = useRef<readonly CapturedFish[]>(capturedFish);
  const tiltRef = useRef(tilt);
  useEffect(() => {
    fishRef.current = capturedFish;
  }, [capturedFish]);
  useEffect(() => {
    tiltRef.current = tilt;
  }, [tilt]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const sim = simRef.current;
    if (!host || !canvas || !sim) return;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    let cssW = 0;
    let cssH = 0;
    let dpr = 1;
    let bounds = computeBounds(1, 1);
    let raf = 0;
    let lastT = 0;

    const step = (t: number, dt: number) => {
      if (cssW <= 0 || cssH <= 0) return;
      // The server list is the truth; sync is idempotent and cheap.
      sim.sync(fishRef.current);
      sim.setTilt(tiltRef.current);
      sim.update(dt, t);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      drawBowl(ctx, bounds, sim, t);
    };

    const frame = (ms: number) => {
      raf = requestAnimationFrame(frame);
      const t = ms / 1000;
      const dt = lastT > 0 ? t - lastT : 1 / 60;
      lastT = t;
      if (cssW <= 0 || cssH <= 0) {
        resize();
        return;
      }
      step(t, dt);
    };

    const resize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w <= 0 || h <= 0) return;
      dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
      const pw = Math.max(1, Math.round(w * dpr));
      const ph = Math.max(1, Math.round(h * dpr));
      // Resizing the backing store clears it, so always repaint afterwards.
      if (canvas.width !== pw) canvas.width = pw;
      if (canvas.height !== ph) canvas.height = ph;
      cssW = w;
      cssH = h;
      bounds = computeBounds(w, h);
      sim.setBounds(bounds);
      // Paint immediately even while the loop is paused: a bowl that has not
      // been animated yet must still show its fish, never an empty rectangle.
      if (raf === 0) step(performance.now() / 1000, 1 / 60);
    };

    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(host);

    const start = () => {
      if (raf !== 0) return;
      // Forget the pre-pause timestamp so the first frame back is not a jump.
      lastT = 0;
      raf = requestAnimationFrame(frame);
    };

    const stop = () => {
      if (raf === 0) return;
      cancelAnimationFrame(raf);
      raf = 0;
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    document.addEventListener('visibilitychange', onVisibility);
    if (!document.hidden) start();

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      observer.disconnect();
      stop();
    };
  }, []);

  return (
    <div
      ref={hostRef}
      className={className}
      style={{
        position: 'relative',
        width: '100%',
        minHeight: 180,
        touchAction: 'none',
        ...style,
      }}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`自分の金魚ボウル 金魚${capturedFish.length}匹`}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          display: 'block',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}
