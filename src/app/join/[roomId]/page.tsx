import type { Metadata } from 'next';

import { PhoneShell } from '@/components/phone/PhoneShell';

/**
 * The smartphone entry point — the URL behind the QR code on the giant screen.
 *
 * A server component with essentially nothing in it: everything a phone does
 * here needs sensors, sockets and animation frames, so the whole client lives in
 * PhoneShell. In Next.js 15 route params arrive as a Promise, hence the await.
 */

export const metadata: Metadata = {
  title: '巨大デジタル金魚すくい — ポイ',
  description: 'スマホをポイのように持って遊びます。',
};

/** Never cache a page whose entire job is to open a live socket. */
export const dynamic = 'force-dynamic';

interface JoinPageProps {
  params: Promise<{ roomId: string }>;
}

export default async function JoinPage({ params }: JoinPageProps) {
  const { roomId } = await params;
  // The server normalises the id itself; decode only what the URL escaped.
  return <PhoneShell roomId={decodeURIComponent(roomId)} />;
}
