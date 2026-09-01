'use client';

/**
 * The client half of the boot sentinel (see src/app/boot.ts).
 *
 * Mounting anywhere in the tree means React executed and hydrated — the exact
 * fact the inline script is waiting to hear. It raises the flag, clears the
 * one-shot reload guard so a future failure gets its own retry, and removes
 * anything the sentinel drew while the page was still on its way up.
 */

import { useEffect } from 'react';

import { BANNER_ID, HYDRATED_FLAG, RELOAD_GUARD_KEY, TOAST_ID } from '@/app/boot';

export function HydrationBeacon() {
  useEffect(() => {
    (window as unknown as Record<string, unknown>)[HYDRATED_FLAG] = true;
    try {
      sessionStorage.removeItem(RELOAD_GUARD_KEY);
    } catch {
      /* private-mode Safari; the guard simply stays, which is harmless */
    }
    document.getElementById(BANNER_ID)?.remove();
    document.getElementById(TOAST_ID)?.remove();
  }, []);

  return null;
}
