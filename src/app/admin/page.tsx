'use client';

import { Suspense, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { AdminConsole } from '@/components/admin/AdminConsole';

const DEFAULT_ROOM_ID = 'FESTIVAL01';

function normalizeRoomId(raw: string | null | undefined): string {
  const cleaned = (raw ?? '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  return cleaned.length > 0 ? cleaned : DEFAULT_ROOM_ID;
}

function AdminRoute() {
  const params = useSearchParams();
  const router = useRouter();
  const roomId = normalizeRoomId(params?.get('room'));

  const onRoomIdChange = useCallback(
    (next: string) => {
      const id = normalizeRoomId(next);
      router.replace('/admin?room=' + encodeURIComponent(id));
    },
    [router],
  );

  return <AdminConsole roomId={roomId} onRoomIdChange={onRoomIdChange} />;
}

function AdminFallback() {
  return (
    <main
      style={{
        height: 'auto',
        minHeight: '100vh',
        background: 'var(--night-0)',
        color: 'var(--ink-dim)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 13,
        letterSpacing: '0.1em',
      }}
    >
      運営コンソールを読み込んでいます…
    </main>
  );
}

export default function AdminPage() {
  return (
    <Suspense fallback={<AdminFallback />}>
      <AdminRoute />
    </Suspense>
  );
}
