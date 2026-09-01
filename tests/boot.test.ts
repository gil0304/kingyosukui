/**
 * The boot sentinel is the code that runs when nothing else could — so nothing
 * may quietly modernise it, detach it from the document, or unhook the two
 * sides (inline script and React beacon) from each other.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  BANNER_ID,
  BOOT_SCRIPT,
  BOOT_TIMEOUT_SECONDS,
  HYDRATED_FLAG,
  RELOAD_GUARD_KEY,
  TOAST_ID,
} from '@/app/boot';

const read = (rel: string): string =>
  fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

describe('boot sentinel script', () => {
  it('is valid JavaScript', () => {
    // eslint-disable-next-line no-new-func
    expect(() => new Function(BOOT_SCRIPT)).not.toThrow();
  });

  it('stays ES5 — it must parse on exactly the browsers the bundle might not', () => {
    // Arrow functions, template literals and block-scoped declarations are the
    // usual accidental modernisations.
    expect(BOOT_SCRIPT).not.toMatch(/=>/);
    expect(BOOT_SCRIPT).not.toMatch(/`/);
    expect(BOOT_SCRIPT).not.toMatch(/\b(const|let)\s/);
    expect(BOOT_SCRIPT).not.toMatch(/\.\.\./);
    expect(BOOT_SCRIPT).not.toMatch(/\?\./);
  });

  it('captures errors, answers the join tap, and retries exactly once', () => {
    expect(BOOT_SCRIPT).toContain("addEventListener('error'");
    expect(BOOT_SCRIPT).toContain("addEventListener('unhandledrejection'");
    expect(BOOT_SCRIPT).toContain('join-button');
    expect(BOOT_SCRIPT).toContain(RELOAD_GUARD_KEY);
    expect(BOOT_SCRIPT).toContain(HYDRATED_FLAG);
    expect(BOOT_SCRIPT).toContain(BANNER_ID);
    expect(BOOT_SCRIPT).toContain(TOAST_ID);
    expect(BOOT_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(5);
  });
});

describe('the two halves are actually wired together', () => {
  it('the layout injects the sentinel and mounts the beacon', () => {
    const layout = read('src/app/layout.tsx');
    expect(layout).toContain('BOOT_SCRIPT');
    expect(layout).toContain('<HydrationBeacon />');
  });

  it('the join button carries the id the sentinel listens for', () => {
    expect(read('src/components/phone/JoinGate.tsx')).toContain('id="join-button"');
  });

  it('the beacon raises the same flag the sentinel waits on', () => {
    const beacon = read('src/components/HydrationBeacon.tsx');
    expect(beacon).toContain('HYDRATED_FLAG');
    expect(beacon).toContain('RELOAD_GUARD_KEY');
  });

  it('HTML documents are pinned to no-store so a rebuild cannot strand a phone', () => {
    const config = read('next.config.mjs');
    expect(config).toContain('no-store');
    for (const route of ["'/join/:path*'", "'/screen/:path*'", "'/admin'"]) {
      expect(config).toContain(route);
    }
  });
});
