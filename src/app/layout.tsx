import type { Metadata, Viewport } from 'next';
import './globals.css';
import { BOOT_SCRIPT } from './boot';
import { CRITICAL_CSS } from './theme';
import { HydrationBeacon } from '@/components/HydrationBeacon';

export const metadata: Metadata = {
  title: '巨大デジタル金魚すくい',
  description: 'スマホをポイにして、みんなで壁一面の金魚をすくう。',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: '金魚すくい' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  // The phone is a physical controller — pinch-zooming it would be nonsense.
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#07080f',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        {/*
          The palette travels inside the document. If the external stylesheet
          ever fails to arrive — a stale CSS chunk after a rebuild, a proxy, a
          dropped tunnel — the phone still renders readable text and a visible
          参加する button instead of black on black.
        */}
        <style dangerouslySetInnerHTML={{ __html: CRITICAL_CSS }} />
        {/*
          The boot sentinel (src/app/boot.ts): inline, dependency-free ES5 that
          notices when the JavaScript bundle never starts — the stale-cache /
          dead-chunk failure that leaves the page looking alive but ignoring
          every tap — then repairs it with one cache-busted reload, or says
          plainly what failed. HydrationBeacon below is its all-clear signal.
        */}
        <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
      </head>
      <body>
        <HydrationBeacon />
        {children}
      </body>
    </html>
  );
}
