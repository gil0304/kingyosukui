/**
 * The decision logic behind the crash-screen auto-reload, kept pure so tests
 * can pin it. Two questions:
 *
 *   1. What URL do we reload to? (same page, fresh cache-busting token,
 *      never stacking tokens from previous recoveries)
 *   2. Are we still within the reload budget, or is this build genuinely
 *      broken and reloading would just strobe the projector?
 */

export const RELOAD_GUARD_KEY = 'kgs-err-reloads';
export const RELOAD_GUARD_WINDOW_MS = 90_000;
export const RELOAD_GUARD_MAX = 3;
export const RELOAD_DELAY_MS = 2500;

/** Same URL with a fresh kgsr= token — any previous token is replaced. */
export function withCacheBuster(href: string, token: string): string {
  const stripped = href.replace(/([?&])kgsr=[^&]*&?/, '$1').replace(/[?&]$/, '');
  return `${stripped}${stripped.includes('?') ? '&' : '?'}kgsr=${token}`;
}

export interface ReloadBudget {
  /** May we auto-reload right now? */
  ok: boolean;
  /** The serialized history to store back (only meaningful when ok). */
  next: string;
}

/**
 * raw is the stored JSON history of recent auto-reload timestamps (or null /
 * garbage — storage is hostile territory on iOS private mode).
 */
export function takeReloadBudget(raw: string | null, now: number): ReloadBudget {
  let list: number[] = [];
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]');
    if (Array.isArray(parsed)) list = parsed.filter((t): t is number => typeof t === 'number');
  } catch {
    list = [];
  }
  list = list.filter((t) => now - t < RELOAD_GUARD_WINDOW_MS);
  if (list.length >= RELOAD_GUARD_MAX) return { ok: false, next: JSON.stringify(list) };
  list.push(now);
  return { ok: true, next: JSON.stringify(list) };
}

/**
 * The side-effectful wrapper both error boundaries share: consult storage,
 * spend one token if available. Storage failure means we cannot guard against
 * loops, but a single reload per mount is still the best move — the reloaded
 * page starts from scratch anyway.
 */
export function tryTakeReloadToken(): boolean {
  try {
    const budget = takeReloadBudget(sessionStorage.getItem(RELOAD_GUARD_KEY), Date.now());
    if (budget.ok) sessionStorage.setItem(RELOAD_GUARD_KEY, budget.next);
    return budget.ok;
  } catch {
    return true;
  }
}

/** Full recovery URL for right now. */
export function recoveryUrl(): string {
  return withCacheBuster(location.href, Date.now().toString(36));
}
