import { webkit } from 'playwright';

const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message)));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`console.${m.type()}: ${m.text()}`);
});

await page.goto('http://localhost:3000/screen/FESTIVAL01?debug=1', { waitUntil: 'load' });
await page.waitForTimeout(8000);

const state = await page.evaluate(() => ({
  hasCanvas: !!document.querySelector('canvas'),
  bodyText: (document.body.innerText || '').slice(0, 200),
  hydrated: window.__kgsHydrated,
  bootErrors: (window.__kgsBoot && window.__kgsBoot.errors) || [],
}));

console.log('STATE:', JSON.stringify(state, null, 1));
console.log('ERRORS (' + errors.length + '):');
for (const e of errors.slice(0, 12)) console.log('  ' + e.slice(0, 500));
await browser.close();
