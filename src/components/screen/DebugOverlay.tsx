'use client';

/**
 * Venue diagnostics, only when the URL carries ?debug=1 (spec §120).
 *
 * This is what an operator looks at when a player says "it feels laggy": frame rate,
 * whether fish snapshots are actually arriving at 30 Hz, how many poi the server thinks
 * exist, and how far the room clock is from ours.
 *
 * Nothing here samples the poi buffer — sampling advances its smoothing state, and a
 * debug panel must never change what the tank does.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { FrameHealthReadout } from '@/components/screen/FrameHealth';

import { GAME } from '@/game/core/constants';
import type { FishSnapshotBuffer, PoiStateBuffer } from '@/network/state/snapshotBuffer';
import type { PhasePayload } from '@/network/protocol/events';
import type { RoomPublicState } from '@/types';
import type { ServerClock } from '@/components/screen/ScreenHud';

export interface DebugOverlayProps {
  room: RoomPublicState | null;
  phase: PhasePayload | null;
  connected: boolean;
  fishBuffer: FishSnapshotBuffer;
  poiBuffer: PoiStateBuffer;
  clock: ServerClock;
}

interface Readout {
  fps: number;
  fishHz: number;
  poi: number;
  frameMs: number;
}

const row: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 18,
  lineHeight: 1.55,
};

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={row}>
      <span style={{ color: 'rgba(169,160,143,0.75)' }}>{label}</span>
      <span className="tabular" style={{ color: warn ? '#ff8a70' : 'var(--ink)' }}>
        {value}
      </span>
    </div>
  );
}

export function DebugOverlay({
  room,
  phase,
  connected,
  fishBuffer,
  poiBuffer,
  clock,
}: DebugOverlayProps) {
  const [readout, setReadout] = useState<Readout>({ fps: 0, fishHz: 0, poi: 0, frameMs: 0 });
  const [latency, setLatency] = useState({ offset: 0, jitter: 0 });

  const buffers = useRef({ fishBuffer, poiBuffer, clock });
  buffers.current = { fishBuffer, poiBuffer, clock };

  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let worst = 0;
    let last = performance.now();
    let windowStart = last;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = now - last;
      last = now;
      frames++;
      if (dt > worst) worst = dt;

      if (now - windowStart < 500) return;

      const { fishBuffer: fb, poiBuffer: pb, clock: ck } = buffers.current;
      let poi = 0;
      for (let n = 1; n <= GAME.hardMaxPlayers; n++) if (pb.get(n)) poi++;

      setReadout({
        fps: Math.round((frames * 1000) / (now - windowStart)),
        fishHz: fb.fps,
        poi,
        frameMs: Math.round(worst * 10) / 10,
      });
      setLatency({ offset: Math.round(ck.offsetMs()), jitter: Math.round(ck.latencyMs()) });

      frames = 0;
      worst = 0;
      windowStart = now;
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      style={{
        position: 'absolute',
        left: 20,
        top: 92,
        width: 268,
        padding: '12px 14px 13px',
        borderRadius: 10,
        background: 'rgba(5,6,12,0.82)',
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.12)',
        fontFamily: 'var(--font-num)',
        fontSize: 12,
        color: 'var(--ink)',
        pointerEvents: 'none',
        zIndex: 40,
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: '0.3em',
          color: 'var(--lantern)',
          marginBottom: 8,
        }}
      >
        DEBUG
      </div>

      <Row label="FPS" value={`${readout.fps}`} warn={readout.fps > 0 && readout.fps < 50} />
      <Row label="worst frame" value={`${readout.frameMs.toFixed(1)} ms`} warn={readout.frameMs > 33} />
      <Row
        label="fish snapshots"
        value={`${readout.fishHz} Hz`}
        warn={connected && readout.fishHz > 0 && readout.fishHz < GAME.fishSnapshotHz - 6}
      />
      <Row label="poi" value={`${readout.poi}`} />
      <Row label="latency" value={`~${latency.jitter} ms`} warn={latency.jitter > 90} />
      <Row label="clock offset" value={`${latency.offset > 0 ? '+' : ''}${latency.offset} ms`} />

      <div style={{ height: 1, background: 'rgba(255,255,255,0.10)', margin: '8px 0' }} />

      <Row label="socket" value={connected ? 'connected' : 'OFFLINE'} warn={!connected} />
      <Row label="room" value={room?.id ?? '—'} />
      <Row label="state" value={phase?.state ?? room?.state ?? '—'} />
      <Row label="players" value={`${room?.players.length ?? 0}`} />
      <Row label="fish count" value={`${room?.settings.fishCount ?? 0}`} />
      <Row label="quality" value={room?.settings.highQuality ? 'high + postFX' : 'plain'} />
      <Row label="audio" value={room?.settings.audioEnabled ? 'on' : 'muted'} />
      <div style={{ marginTop: 6, color: '#ffd27d' }}>
        <FrameHealthReadout />
      </div>
    </div>
  );
}

export default DebugOverlay;
