'use client';

/**
 * The join QR code (spec §19, §132).
 *
 * A projector is a terrible QR display: it is bright, slightly out of focus and read
 * from four metres away by a phone camera that is also picking up the room lights. So
 * the code is rendered at high error correction, on a real white quiet zone, at twice
 * the CSS size, and never tinted. The URL is printed underneath as well, because
 * someone will always have a camera app that refuses to fire.
 */

import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

export interface QRPanelProps {
  url: string;
  /** CSS size of the white card, in pixels. The bitmap is rendered at 2x this. */
  size?: number;
}

/**
 * Builds the phone join URL for a room from the page that is currently open.
 * Same origin as the screen, which is the whole point of the single-port server.
 *
 * One override: '?join=<origin>' on the screen URL replaces the origin in the QR.
 * That is what makes the hybrid tunnel setup work — the projector renders from
 * localhost (zero display latency) while the QR sends the phones through the
 * public ngrok address ('npm run tunnel' prints exactly this URL).
 */
export function buildJoinUrl(roomId: string): string {
  const path = `/join/${encodeURIComponent(roomId)}`;
  if (typeof window === 'undefined') return path;

  const override = new URLSearchParams(window.location.search).get('join');
  if (override) {
    try {
      const u = new URL(override.includes('://') ? override : `https://${override}`);
      // Origin only — anything after the host is the QR's business, not the caller's.
      if (u.protocol === 'https:' || u.protocol === 'http:') return `${u.origin}${path}`;
    } catch {
      /* an unparseable override falls back to the local origin */
    }
  }
  return `${window.location.origin}${path}`;
}

/** Strips the scheme so the printed line stays short enough to read at a distance. */
export function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

export function QRPanel({ url, size = 260 }: QRPanelProps) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!url) return undefined;

    QRCode.toDataURL(url, {
      errorCorrectionLevel: 'H',
      // Quiet zone in modules. Four is the spec minimum and the difference between
      // "scans instantly" and "hold it steady for five seconds" on a projection.
      margin: 4,
      width: Math.round(size * 2),
      color: { dark: '#0a0c16', light: '#ffffff' },
    })
      .then((dataUrl) => {
        if (alive) setSrc(dataUrl);
      })
      .catch(() => {
        if (alive) setSrc(null);
      });

    return () => {
      alive = false;
    };
  }, [url, size]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <div
        style={{
          width: size,
          height: size,
          borderRadius: 14,
          background: '#ffffff',
          boxShadow: '0 10px 40px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,182,77,0.35)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt="参加用QRコード"
            width={size}
            height={size}
            style={{ width: '100%', height: '100%', display: 'block', imageRendering: 'pixelated' }}
          />
        ) : (
          <span style={{ color: '#8a8477', fontSize: 13 }}>QR生成中…</span>
        )}
      </div>

      <div
        className="tabular"
        style={{
          color: 'var(--ink-dim)',
          fontSize: Math.max(12, Math.round(size * 0.062)),
          letterSpacing: '0.02em',
          wordBreak: 'break-all',
          textAlign: 'center',
          maxWidth: size + 60,
        }}
      >
        {shortUrl(url)}
      </div>
    </div>
  );
}

export default QRPanel;
