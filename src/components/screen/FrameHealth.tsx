'use client';

/**
 * The black-flash detective, v2 (venue diagnosis, 2026-08-26).
 *
 * The venue projector intermittently shows a 1-2 frame black flash, worst
 * around violent water entries and captures. v1 of this probe measured only a
 * +-600ms window around ENTER splash events, sampled every 3rd frame, and its
 * DOM readout silently froze because it resubscribed on every api identity
 * change (api is rebuilt on every room-state update) — three blind spots that
 * together let real black frames through unreported while the overlay said
 * 異常なし. Lessons learned, v2 is a continuous surveillance camera:
 *
 *   - samples EVERY frame (this probe now mounts only with ?debug=1, so the
 *     readPixels pipeline sync never taxes the show build);
 *   - counts every black frame whenever it happens, not just near entries, and
 *     records WHAT GAME EVENT immediately preceded it — the correlation is the
 *     diagnosis;
 *   - a begin/end frame counter pair (priority -1000 / 999) plus a DOM-side
 *     age check detect a dead render loop and probe-skipping exceptions, the
 *     two states v1 mislabeled as 異常なし;
 *   - subscriptions depend on the stable signal functions, never on api
 *     identity, so the health handle survives room-state churn.
 */

import { useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';

import type { ScreenSocketApi } from '@/network/socket/useScreenSocket';

interface Sample {
  t: number;
  lum: number;
  gap: number;
  /** Which sampled patches were black: '全面', '中央', … or ''. */
  dark: string;
}

interface BlackHit {
  t: number;
  where: string;
  lum: number;
  /** The most recent game event when the black frame was presented. */
  prevEvent: string;
  /**
   * Coarse luminance map of the whole presented frame, top row first.
   * '#' black (<= BLACK_LUM), '+' dim (< 24), '.' lit. The SHAPE of the black
   * is the strongest clue to which pass produced it.
   */
  map?: string[];
}

interface GameEvent {
  kind: string;
  strength: number;
  t: number;
}

export interface EntryVerdict {
  at: number;
  minLum: number;
  meanLum: number;
  maxGapMs: number;
  blackFrames: number;
  verdict: string;
}

interface HealthHandle {
  entries: EntryVerdict[];
  latest: () => EntryVerdict | null;
  counters: { frames: number; sampled: number; blacks: number; startedAt: number };
  blackLog: BlackHit[];
  events: GameEvent[];
  lastFrameAt: () => number;
  /** frames begun minus frames fully probed; growing = an exception mid-frame. */
  loopSkew: () => number;
  programs: () => number;
}

declare global {
  interface Window {
    __kingyoFrameHealth?: HealthHandle;
  }
}

const HISTORY_SECONDS = 4;
const BLACK_LUM = 6;
const STALL_MS = 90;
const BLACK_LOG_MAX = 30;
const EVENT_LOG_MAX = 12;

const fmtEvent = (e: GameEvent | undefined, now: number): string =>
  e ? `${e.kind}(${e.strength.toFixed(2)}) ${Math.round(now - e.t)}ms前` : 'イベント無し';

/** Mounted INSIDE the Canvas, only when ?debug=1. */
export function FrameHealthProbe({ api }: { api: ScreenSocketApi }) {
  const gl = useThree((s) => s.gl);
  const samples = useRef<Sample[]>([]);
  const lastT = useRef(0);
  const began = useRef(0);
  const ended = useRef(0);
  const px = useRef(new Uint8Array(16 * 16 * 4));
  const fullPx = useRef<Uint8Array | null>(null);

  const handle = useRef<HealthHandle>(null!);
  if (!handle.current) {
    const h: HealthHandle = {
      entries: [],
      latest: () => h.entries[h.entries.length - 1] ?? null,
      counters: { frames: 0, sampled: 0, blacks: 0, startedAt: 0 },
      blackLog: [],
      events: [],
      lastFrameAt: () => lastT.current,
      loopSkew: () => began.current - ended.current,
      programs: () => gl.info.programs?.length ?? -1,
    };
    handle.current = h;
  }

  // A frame "begins" before anything draws. If this advances while the 999
  // probe below does not, some earlier useFrame callback is throwing and the
  // frame reached the display unmeasured.
  useFrame(() => {
    began.current++;
  }, -1000);

  // Priority 999: AFTER the water pass and the composer have drawn this frame.
  // (v1 ran at −50, pre-draw, and measured the undefined backbuffer — its
  // false 黒フレーム verdict cost a day. Read only what the player sees.)
  useFrame(() => {
    const now = performance.now();
    const gap = lastT.current ? now - lastT.current : 16;
    lastT.current = now;

    const h = handle.current;
    h.counters.frames++;
    if (!h.counters.startedAt) h.counters.startedAt = now;

    let lum = -1;
    let dark = '';
    const ctx = gl.getContext();
    const prev = ctx.getParameter(ctx.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    try {
      const w = gl.domElement.width;
      const h2 = gl.domElement.height;
      ctx.bindFramebuffer(ctx.FRAMEBUFFER, null);
      // Five patches — centre and the four quadrants — so a true black frame
      // can also say WHERE it is black (whole screen vs the tank centre).
      const spots: Array<[string, number, number]> = [
        ['中央', w >> 1, h2 >> 1],
        ['左上', w >> 2, (h2 * 3) >> 2],
        ['右上', (w * 3) >> 2, (h2 * 3) >> 2],
        ['左下', w >> 2, h2 >> 2],
        ['右下', (w * 3) >> 2, h2 >> 2],
      ];
      let total = 0;
      const darkSpots: string[] = [];
      for (const [name, sx, sy] of spots) {
        ctx.readPixels(sx - 4, sy - 4, 8, 8, ctx.RGBA, ctx.UNSIGNED_BYTE, px.current);
        let sum = 0;
        const p = px.current;
        for (let i = 0; i < 8 * 8 * 4; i += 8) sum += p[i]! + p[i + 1]! + p[i + 2]!;
        const l = Math.round(sum / ((8 * 8 * 4) / 8) / 3);
        total += l;
        if (l <= BLACK_LUM) darkSpots.push(name);
      }
      lum = Math.round(total / spots.length);
      dark = darkSpots.length === spots.length ? '全面' : darkSpots.join(',');
      h.counters.sampled++;
    } catch {
      /* diagnosis must never break the show */
    } finally {
      ctx.bindFramebuffer(ctx.FRAMEBUFFER, prev);
    }

    // The verdict counts only a black CENTRE or a fully black frame — the
    // night scenery legitimately darkens the corners.
    if (lum >= 0 && (dark === '全面' || dark.includes('中央'))) {
      h.counters.blacks++;
      const prevEvent = fmtEvent(h.events[h.events.length - 1], now);
      const hit: BlackHit = { t: now, where: dark, lum, prevEvent };
      // One full-canvas read per hit: expensive, but the spatial shape of the
      // black (half-screen? bands? noise?) identifies the guilty pass.
      try {
        const ctx2 = gl.getContext();
        const w = gl.domElement.width;
        const h2 = gl.domElement.height;
        const need = w * h2 * 4;
        if (!fullPx.current || fullPx.current.length < need) {
          fullPx.current = new Uint8Array(need);
        }
        const prev2 = ctx2.getParameter(ctx2.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
        ctx2.bindFramebuffer(ctx2.FRAMEBUFFER, null);
        ctx2.readPixels(0, 0, w, h2, ctx2.RGBA, ctx2.UNSIGNED_BYTE, fullPx.current);
        ctx2.bindFramebuffer(ctx2.FRAMEBUFFER, prev2);
        const gw = 48;
        const gh = 27;
        const grid: string[] = [];
        for (let gy = 0; gy < gh; gy++) {
          let row = '';
          for (let gx = 0; gx < gw; gx++) {
            const sxp = Math.floor(((gx + 0.5) / gw) * w);
            const syp = Math.floor(((gh - gy - 0.5) / gh) * h2);
            const i = (syp * w + sxp) * 4;
            const l =
              (fullPx.current[i]! + fullPx.current[i + 1]! + fullPx.current[i + 2]!) / 3;
            row += l <= BLACK_LUM ? '#' : l < 24 ? '+' : '.';
          }
          grid.push(row);
        }
        hit.map = grid;
      } catch {
        /* map is optional */
      }
      h.blackLog.push(hit);
      if (h.blackLog.length > BLACK_LOG_MAX) h.blackLog.shift();
      // eslint-disable-next-line no-console
      console.log(
        `[kingyo] 黒フレーム検出 #${h.counters.blacks} t=${Math.round(now)}ms 場所=${dark} 輝度=${lum} 直前=${prevEvent}`,
      );
    }

    const list = samples.current;
    list.push({ t: now, lum, gap, dark });
    const cutoff = now - HISTORY_SECONDS * 1000;
    while (list.length && list[0]!.t < cutoff) list.shift();

    ended.current++;
  }, 999);

  useEffect(() => {
    window.__kingyoFrameHealth = handle.current;
    return () => {
      delete window.__kingyoFrameHealth;
    };
  }, []);

  // Game-event ticker + per-entry verdicts. Depends on the STABLE subscribe
  // functions — never on api identity, which changes on every room update.
  const { onSplash, onCapture, onBreak } = api;
  useEffect(() => {
    const h = handle.current;
    const push = (kind: string, strength: number) => {
      h.events.push({ kind, strength, t: performance.now() });
      if (h.events.length > EVENT_LOG_MAX) h.events.shift();
    };

    const offs = [
      onCapture((p) => push('捕獲', 'score' in p ? 1 : 1)),
      onBreak(() => push('破れ', 1)),
      onSplash((p) => {
        push(p.kind, p.strength);
        if (p.kind !== 'ENTER') return;
        const at = performance.now();
        // Wait so the window covers frames AFTER the entry too.
        window.setTimeout(() => {
          const verdictTime = performance.now();
          const windowed = samples.current.filter((s) => Math.abs(s.t - at) < 600);
          const measured = windowed.filter((s) => s.lum >= 0);
          const after = measured.filter((s) => s.t > at);
          const lums = measured.map((s) => s.lum);
          const gaps = windowed.map((s) => s.gap);
          const minLum = lums.length ? Math.min(...lums) : -1;
          const meanLum = lums.length
            ? Math.round(lums.reduce((a, b) => a + b, 0) / lums.length)
            : -1;
          const blackSamples = measured.filter(
            (s) => s.dark === '全面' || s.dark.includes('中央'),
          );
          const blackFrames = blackSamples.length;
          // A stall that swallowed the whole window leaves no resume sample
          // inside it: charge the silence since the last sample as a gap too.
          const lastSampleT = samples.current.length
            ? samples.current[samples.current.length - 1]!.t
            : at;
          const maxGapMs = Math.round(
            Math.max(gaps.length ? Math.max(...gaps) : 0, verdictTime - lastSampleT),
          );
          const where = blackSamples.some((s) => s.dark === '全面')
            ? '全面'
            : [...new Set(blackSamples.map((s) => s.dark))].join('/');

          const verdict = !after.length
            ? `計測不能 (入水後のフレーム欠落, 無音${maxGapMs}ms)`
            : blackFrames > 0
              ? `黒フレーム有り (${blackFrames}枚, 場所:${where})`
              : maxGapMs >= STALL_MS
                ? `ストール有り (最大${maxGapMs}ms)`
                : `異常なし (輝度${minLum}〜${meanLum}, 最大${maxGapMs}ms)`;

          const entry: EntryVerdict = { at, minLum, meanLum, maxGapMs, blackFrames, verdict };
          h.entries.push(entry);
          if (h.entries.length > 20) h.entries.shift();
          // eslint-disable-next-line no-console
          console.log(`[kingyo] 入水診断: ${verdict}`);
        }, 600);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [onSplash, onCapture, onBreak]);

  return null;
}

/** The multi-line readout for the debug overlay (DOM side, timer-driven —
 *  it keeps updating even when the render loop is dead, which is exactly
 *  the state it exists to expose). */
export function FrameHealthReadout() {
  const [lines, setLines] = useState('入水診断: 起動中…');
  useEffect(() => {
    const id = window.setInterval(() => {
      const h = window.__kingyoFrameHealth;
      const now = performance.now();
      if (!h) {
        setLines('入水診断: プローブ未搭載 (?debug=1 で有効)');
        return;
      }
      const upSec = h.counters.startedAt ? ((now - h.counters.startedAt) / 1000).toFixed(0) : '0';
      const frameAge = now - h.lastFrameAt();
      const skew = h.loopSkew();

      const alerts: string[] = [];
      if (h.lastFrameAt() > 0 && frameAge > 600 && document.visibilityState === 'visible') {
        alerts.push(`描画停止 ${Math.round(frameAge)}ms`);
      }
      if (skew > 2) alerts.push(`診断スキップ x${skew} (フレーム内例外)`);

      const lastBlack = h.blackLog[h.blackLog.length - 1];
      const blackInfo = lastBlack
        ? `黒${h.counters.blacks}枚 直近${((now - lastBlack.t) / 1000).toFixed(1)}s前[${lastBlack.where}] 直前:${lastBlack.prevEvent}`
        : `黒0枚`;

      const latest = h.latest();
      const ev = h.events
        .slice(-3)
        .map((e) => `${e.kind}${((now - e.t) / 1000).toFixed(0)}s`)
        .join(' ');

      setLines(
        [
          `監視${upSec}s ${blackInfo} prog=${h.programs()}${alerts.length ? ' ⚠ ' + alerts.join(' / ') : ''}`,
          `入水診断#${h.entries.length}: ${latest ? latest.verdict : '待機中（ポイを水に入れてください）'}`,
          ev ? `イベント: ${ev}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }, 400);
    return () => window.clearInterval(id);
  }, []);
  return <span style={{ whiteSpace: 'pre-line' }}>{lines}</span>;
}
