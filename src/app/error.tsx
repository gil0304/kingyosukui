'use client';

/**
 * The in-app crash screen — and, more importantly, the auto-repair for it.
 *
 * Next's default fallback is a black page with one English sentence, and at a
 * venue it appears for exactly one predictable reason: a screen or phone that
 * loaded the app before a rebuild asks for a lazy chunk the new build renamed.
 * The projector then shows a black wall until a human finds the keyboard.
 *
 * A reload fixes that case completely (fresh HTML names fresh chunks), so this
 * boundary reloads ITSELF: after a short beat, with a cache-busting query, and
 * with a loop guard so a genuinely broken build degrades into a calm screen
 * with a button instead of a reload storm. Logic lives in errorRecovery.ts.
 */

import { useEffect, useState } from 'react';
import { RELOAD_DELAY_MS, recoveryUrl, tryTakeReloadToken } from './errorRecovery';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [autoReloading, setAutoReloading] = useState(false);

  useEffect(() => {
    if (!tryTakeReloadToken()) return;
    setAutoReloading(true);
    const id = window.setTimeout(() => location.replace(recoveryUrl()), RELOAD_DELAY_MS);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 18,
        padding: 32,
        textAlign: 'center',
        background:
          'radial-gradient(120% 80% at 50% 0%, #151a30 0%, #0a0c18 55%, #05060c 100%)',
        color: 'var(--ink, #f4efe4)',
        fontFamily: 'var(--font-ui, system-ui, sans-serif)',
      }}
    >
      <div style={{ fontSize: 40 }}>🏮</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--lantern, #ffb64d)' }}>
        {autoReloading ? '読み込み直しています…' : 'アプリでエラーが起きました'}
      </div>
      <div style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--ink-dim, #a9a08f)', maxWidth: 420 }}>
        {autoReloading
          ? 'そのままお待ちください。すぐに戻ります。'
          : '自動復旧できませんでした。下のボタンでやり直してください。'}
        {error?.digest ? (
          <span style={{ display: 'block', marginTop: 8, fontSize: 11, opacity: 0.6 }}>
            code: {error.digest}
          </span>
        ) : null}
      </div>
      {!autoReloading && (
        <div style={{ display: 'flex', gap: 12 }}>
          <button
            type="button"
            onClick={() => location.replace(recoveryUrl())}
            style={{
              minHeight: 52,
              padding: '12px 30px',
              border: 'none',
              borderRadius: 12,
              background:
                'linear-gradient(170deg, var(--lantern, #ffb64d) 0%, var(--lantern-deep, #e2612b) 100%)',
              color: '#20120a',
              fontSize: 17,
              fontWeight: 800,
              cursor: 'pointer',
            }}
          >
            再読み込み
          </button>
          <button
            type="button"
            onClick={reset}
            style={{
              minHeight: 52,
              padding: '12px 22px',
              borderRadius: 12,
              border: '1px solid rgba(226,238,248,0.25)',
              background: 'transparent',
              color: 'rgba(226,238,248,0.75)',
              fontSize: 14,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            もう一度試す
          </button>
        </div>
      )}
    </div>
  );
}
