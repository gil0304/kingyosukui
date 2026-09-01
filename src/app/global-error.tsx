'use client';

/**
 * Last-resort boundary: even the root layout failed, so nothing — CSS variables
 * included — can be assumed. Everything here is inline and self-contained.
 * Same self-repair as app/error.tsx: a crash at a venue is almost always a
 * stale client meeting a fresh build, and a reload cures it.
 */

import { useEffect, useState } from 'react';
import { RELOAD_DELAY_MS, recoveryUrl, tryTakeReloadToken } from './errorRecovery';

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  const [auto, setAuto] = useState(false);

  useEffect(() => {
    if (!tryTakeReloadToken()) return;
    setAuto(true);
    const id = window.setTimeout(() => location.replace(recoveryUrl()), RELOAD_DELAY_MS);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <html lang="ja">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          padding: 32,
          textAlign: 'center',
          background: '#0a0c18',
          color: '#f4efe4',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ fontSize: 38 }}>🏮</div>
        <div style={{ fontSize: 21, fontWeight: 800, color: '#ffb64d' }}>
          {auto ? '読み込み直しています…' : 'アプリでエラーが起きました'}
        </div>
        <div style={{ fontSize: 14, color: '#a9a08f', maxWidth: 420, lineHeight: 1.7 }}>
          {auto ? 'そのままお待ちください。すぐに戻ります。' : '下のボタンでやり直してください。'}
          {error?.digest ? (
            <span style={{ display: 'block', marginTop: 8, fontSize: 11, opacity: 0.6 }}>
              code: {error.digest}
            </span>
          ) : null}
        </div>
        {!auto && (
          <button
            type="button"
            onClick={() => location.replace(recoveryUrl())}
            style={{
              minHeight: 52,
              padding: '12px 30px',
              border: 'none',
              borderRadius: 12,
              background: '#ffb64d',
              color: '#20120a',
              fontSize: 17,
              fontWeight: 800,
              cursor: 'pointer',
            }}
          >
            再読み込み
          </button>
        )}
      </body>
    </html>
  );
}
