/**
 * The palette is a load-bearing part of the phone UI.
 *
 * Every colour in the piece is a CSS custom property. When the stylesheet
 * carrying those properties failed to reach a phone at a venue, `var(--ink)`
 * and `var(--lantern)` resolved to nothing: the text went black on the dark
 * background and the 参加する button lost its fill entirely. The screen looked
 * blank and the one tap in the whole installation was invisible.
 *
 * The fix was to ship the palette inside the HTML document. These tests keep it
 * that way, and — more usefully — fail the moment any component starts using a
 * variable the palette does not define.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { CRITICAL_CSS, THEME_VARS } from '@/app/theme';

const SRC = path.resolve(__dirname, '..', 'src');

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|css)$/.test(entry.name)) out.push(full);
  }
  return out;
};

describe('critical CSS', () => {
  it('defines the palette and the colours the phone cannot do without', () => {
    for (const name of ['--ink', '--ink-dim', '--lantern', '--lantern-deep', '--night-0']) {
      expect(CRITICAL_CSS).toContain(`${name}:`);
    }
    // Literal, variable-free values for the page ground and default text: these
    // have to survive even a total failure of the cascade.
    expect(CRITICAL_CSS).toMatch(/background:#07080f/);
    expect(CRITICAL_CSS).toMatch(/color:#f4efe4/);
  });

  it('carries the controller surface rule, which globals.css would otherwise own', () => {
    expect(CRITICAL_CSS).toContain('.controller-surface');
    expect(CRITICAL_CSS).toContain('touch-action:none');
  });

  it('is injected by the root layout, not merely exported', () => {
    const layout = fs.readFileSync(path.join(SRC, 'app', 'layout.tsx'), 'utf8');
    expect(layout).toContain('CRITICAL_CSS');
    expect(layout).toMatch(/<style[^>]*dangerouslySetInnerHTML/);
  });
});

describe('every CSS variable used anywhere is actually defined', () => {
  const files = walk(SRC);
  const used = new Map<string, string[]>();

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
      const name = m[1]!.toLowerCase();
      const list = used.get(name) ?? [];
      list.push(path.relative(SRC, file));
      used.set(name, list);
    }
  }

  it('finds the variables in the first place (guards the scanner itself)', () => {
    expect(used.size).toBeGreaterThan(5);
    expect(used.has('--lantern')).toBe(true);
  });

  it('has no undefined variable anywhere in src', () => {
    const defined = new Set(Object.keys(THEME_VARS));
    const missing: string[] = [];
    for (const [name, where] of used) {
      // Variables a component defines and consumes locally are its own business.
      if (!defined.has(name)) missing.push(`${name} (used in ${where[0]})`);
    }
    expect(missing).toEqual([]);
  });

  it('keeps globals.css and the inlined palette from drifting apart', () => {
    const globals = fs.readFileSync(path.join(SRC, 'app', 'globals.css'), 'utf8');
    for (const [name, value] of Object.entries(THEME_VARS)) {
      if (!globals.includes(`${name}:`)) continue; // only checks what globals.css restates
      const declared = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(globals)?.[1]?.trim();
      expect(declared, `${name} differs between globals.css and theme.ts`).toBe(value);
    }
  });
});
