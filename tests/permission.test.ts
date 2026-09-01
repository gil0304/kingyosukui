/**
 * iOS consumes the page's user activation at the FIRST requestPermission() call.
 *
 * The join button is the only tap in the entire installation, and it has exactly
 * one chance to raise both sensor prompts. An implementation that awaits the
 * first request before starting the second gets NotAllowedError on the second,
 * reports 'denied', and strands the player on the join screen having already
 * granted permission — which is precisely how this shipped once.
 *
 * These tests pin the ordering, not just the return value.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { detectMotionCapabilities, requestMotionPermission } from '@/controller/sensors/permission';

type Ctor = { requestPermission?: () => Promise<string> };

const g = globalThis as unknown as {
  window?: unknown;
  DeviceOrientationEvent?: Ctor;
  DeviceMotionEvent?: Ctor;
};

const cleanup: Array<() => void> = [];

const install = (opts: {
  orientation?: () => Promise<string>;
  motion?: () => Promise<string>;
  secureContext?: boolean;
}): void => {
  const prev = {
    window: g.window,
    o: g.DeviceOrientationEvent,
    m: g.DeviceMotionEvent,
  };
  g.window = { isSecureContext: opts.secureContext ?? true };
  g.DeviceOrientationEvent = opts.orientation ? { requestPermission: opts.orientation } : {};
  g.DeviceMotionEvent = opts.motion ? { requestPermission: opts.motion } : {};
  cleanup.push(() => {
    g.window = prev.window;
    g.DeviceOrientationEvent = prev.o;
    g.DeviceMotionEvent = prev.m;
  });
};

afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
  vi.restoreAllMocks();
});

describe('requestMotionPermission — the one tap', () => {
  it('starts BOTH requests before awaiting either (the iOS gesture rule)', async () => {
    const calls: string[] = [];
    let releaseOrientation: (v: string) => void = () => {};
    const orientationPromise = new Promise<string>((res) => {
      releaseOrientation = res;
    });

    install({
      orientation: () => {
        calls.push('orientation');
        return orientationPromise;
      },
      motion: () => {
        calls.push('motion');
        return Promise.resolve('granted');
      },
    });

    const pending = requestMotionPermission();
    // Nothing has resolved yet. If the implementation awaited the first request,
    // 'motion' would still be unrequested here — and on a real iPhone that call
    // would land outside the user gesture and throw.
    expect(calls).toEqual(['orientation', 'motion']);

    releaseOrientation('granted');
    await expect(pending).resolves.toBe('granted');
  });

  it('still succeeds when one prompt rejects, as long as the other granted', async () => {
    install({
      orientation: () => Promise.reject(new Error('NotAllowedError')),
      motion: () => Promise.resolve('granted'),
    });
    // Orientation alone is enough to steer; refusing to start would strand a
    // player who has already granted what the game needs.
    await expect(requestMotionPermission()).resolves.toBe('granted');
  });

  it('reports denied only when nothing was granted', async () => {
    install({
      orientation: () => Promise.resolve('denied'),
      motion: () => Promise.resolve('denied'),
    });
    await expect(requestMotionPermission()).resolves.toBe('denied');
  });

  it('treats a dismissed sheet as unknown, not denied', async () => {
    install({
      orientation: () => Promise.resolve('default'),
      motion: () => Promise.resolve('default'),
    });
    await expect(requestMotionPermission()).resolves.toBe('unknown');
  });

  it('grants freely on browsers with no gate (Android, desktop)', async () => {
    install({});
    await expect(requestMotionPermission()).resolves.toBe('granted');
  });

  it('survives a constructor that throws synchronously', async () => {
    install({
      orientation: () => {
        throw new Error('boom');
      },
      motion: () => Promise.resolve('granted'),
    });
    await expect(requestMotionPermission()).resolves.toBe('granted');
  });
});

describe('detectMotionCapabilities', () => {
  it('flags the gate and the secure context the prompt depends on', () => {
    install({ orientation: () => Promise.resolve('granted'), secureContext: true });
    const caps = detectMotionCapabilities();
    expect(caps.needsPermission).toBe(true);
    expect(caps.secureContext).toBe(true);
  });

  it('reports an insecure origin, where the prompt can never succeed', () => {
    install({ motion: () => Promise.resolve('granted'), secureContext: false });
    expect(detectMotionCapabilities().secureContext).toBe(false);
  });
});
