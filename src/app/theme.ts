/**
 * The palette, as the single source of truth.
 *
 * These are injected straight into the HTML document by the root layout rather
 * than living only in globals.css. A venue phone that loaded the page and then
 * lost the stylesheet — a rebuilt server invalidating a cached CSS chunk, a
 * flaky tunnel, a captive-portal proxy — used to render every colour as the
 * CSS-variable fallback of "nothing": black text on the dark background and a
 * 参加する button with no fill at all. The screen looked blank and the one tap
 * in the whole installation became invisible.
 *
 * Shipping the variables inside the HTML makes that failure impossible: there
 * is no separate request that can go missing.
 */

export const THEME_VARS: Record<string, string> = {
  '--night-0': '#07080f',
  '--night-1': '#0d1020',
  '--night-2': '#151a30',
  '--ink': '#f4efe4',
  '--ink-dim': '#a9a08f',
  '--lantern': '#ffb64d',
  '--lantern-deep': '#e2612b',
  '--crimson': '#c8352a',
  '--water': '#2fa2b8',
  '--water-deep': '#123b52',
  '--gold': '#f5c542',

  '--p1': '#e0483a',
  '--p2': '#3f7fd8',
  '--p3': '#e8c33c',
  '--p4': '#4bb264',

  '--font-jp': "'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', 'Shippori Mincho', serif",
  '--font-ui': "'Hiragino Sans', 'Yu Gothic', 'Noto Sans JP', system-ui, -apple-system, sans-serif",
  '--font-num': "'DIN Alternate', 'Helvetica Neue', 'Arial Narrow', system-ui, sans-serif",
};

/**
 * Enough of globals.css to keep the piece legible and usable on its own — the
 * palette plus the handful of rules the phone genuinely cannot do without.
 * Everything else may safely arrive later with the stylesheet.
 */
export const CRITICAL_CSS = `:root{${Object.entries(THEME_VARS)
  .map(([k, v]) => `${k}:${v}`)
  .join(';')}}
*{box-sizing:border-box}
html,body{margin:0;padding:0;height:100%;background:#07080f;color:#f4efe4;
font-family:'Hiragino Sans','Yu Gothic','Noto Sans JP',system-ui,-apple-system,sans-serif;
-webkit-font-smoothing:antialiased}
body{overscroll-behavior:none}
.controller-surface{touch-action:none;-webkit-user-select:none;user-select:none;
-webkit-touch-callout:none;overscroll-behavior:none;overflow:hidden;position:fixed;inset:0}`;
