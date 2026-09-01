import { webkit } from 'playwright';

const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto('http://localhost:3000/screen/SHADERTEST?debug=1', { waitUntil: 'load' });
await page.waitForTimeout(4000);

// Join a bot so a poi mounts and the full pipeline runs.
await page.evaluate(async () => {
  const s = window.io ? null : null; // no client io global; use fetch-free socket via admin? Simpler: use the page's own socket? Not exposed.
});

await page.waitForTimeout(2000);
console.log('=== console output (' + logs.length + ' lines) ===');
for (const l of logs) {
  if (/error|Error|ERROR|shader|Shader|SHADER|Program|link|compile/.test(l)) console.log(l.slice(0, 1200));
}
console.log('=== all types tally ===');
const tally = {};
for (const l of logs) { const t = l.slice(0, l.indexOf(']') + 1); tally[t] = (tally[t] || 0) + 1; }
console.log(JSON.stringify(tally));
await browser.close();
