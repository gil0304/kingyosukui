import { describe, expect, it } from 'vitest';
import {
  RELOAD_GUARD_MAX,
  RELOAD_GUARD_WINDOW_MS,
  takeReloadBudget,
  withCacheBuster,
} from '../src/app/errorRecovery';

// The crash screen may only auto-reload while a reload can plausibly help
// (stale client after a rebuild). A broken build must NOT strobe the
// projector with endless reloads — the budget caps it.

describe('withCacheBuster', () => {
  it('appends kgsr to a bare URL', () => {
    expect(withCacheBuster('https://x.test/play', 'abc')).toBe('https://x.test/play?kgsr=abc');
  });

  it('appends with & when a query already exists', () => {
    expect(withCacheBuster('https://x.test/play?room=A1', 'abc')).toBe(
      'https://x.test/play?room=A1&kgsr=abc',
    );
  });

  it('replaces a previous token instead of stacking them', () => {
    const once = withCacheBuster('https://x.test/play?room=A1', 'one');
    const twice = withCacheBuster(once, 'two');
    expect(twice).toBe('https://x.test/play?room=A1&kgsr=two');
    expect(twice.match(/kgsr=/g)).toHaveLength(1);
  });

  it('survives kgsr sitting mid-query', () => {
    expect(withCacheBuster('https://x.test/play?kgsr=old&room=A1', 'new')).toBe(
      'https://x.test/play?room=A1&kgsr=new',
    );
  });
});

describe('takeReloadBudget', () => {
  const NOW = 1_000_000;

  it('grants the first reload and records it', () => {
    const b = takeReloadBudget(null, NOW);
    expect(b.ok).toBe(true);
    expect(JSON.parse(b.next)).toEqual([NOW]);
  });

  it('denies once the window holds the maximum', () => {
    const recent = Array.from({ length: RELOAD_GUARD_MAX }, (_, i) => NOW - 1000 * (i + 1));
    expect(takeReloadBudget(JSON.stringify(recent), NOW).ok).toBe(false);
  });

  it('forgets reloads older than the window', () => {
    const stale = Array.from(
      { length: RELOAD_GUARD_MAX },
      (_, i) => NOW - RELOAD_GUARD_WINDOW_MS - 1000 * (i + 1),
    );
    const b = takeReloadBudget(JSON.stringify(stale), NOW);
    expect(b.ok).toBe(true);
    expect(JSON.parse(b.next)).toEqual([NOW]);
  });

  it('treats garbage storage as empty history', () => {
    expect(takeReloadBudget('not json {', NOW).ok).toBe(true);
    expect(takeReloadBudget('{"a":1}', NOW).ok).toBe(true);
  });
});
