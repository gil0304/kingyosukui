import fs from 'node:fs';
import path from 'node:path';
import { webkit } from 'playwright';
import { io as ioc } from 'socket.io-client';
import { PNG } from 'pngjs';

// Diagnostic: watch the entry-splash diagnosis overlay evolve over time on WebKit.
// DPR comes from the DPR env var or first CLI arg; defaults to 2.

const DPR = Number(process.env.DPR || process.argv[2] || 2);
const ROOM = process.env.ROOM || ('WKE' + Date.now().toString(36).toUpperCase().slice(-6));
const OUTDIR = '/private/tmp/claude-501/-Users-gilryogo-Developer-gil-kingyosukui/c42e75de-3c65-4203-8dff-5b8f691e6cba/scratchpad/wkentry';
fs.mkdirSync(OUTDIR, { recursive: true });

const ts = () => new Date().toISOString().slice(11, 23);
console.log(`[${ts()}] run start ROOM=${ROOM} DPR=${DPR}`);

const browser = await webkit.launch();
const page = await browser.newPage({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: DPR,
});
page.on('pageerror', (e) => console.log(`[${ts()}] [pageerror] ${e.message}`));
page.on('console', (m) => console.log(`[${ts()}] [console:${m.type()}] ${m.text()}`));

const admin = ioc('http://localhost:3000', { transports: ['websocket'], path: '/socket.io' });
await new Promise((r) => admin.on('connect', r));
admin.emit('admin:join', { roomId: ROOM });
await new Promise((r) => setTimeout(r, 300));
admin.emit('admin:cmd', { type: 'SETTINGS', settings: { highQuality: true } });
await new Promise((r) => setTimeout(r, 300));

await page.goto(`http://localhost:3000/screen/${ROOM}?debug=1`, { waitUntil: 'load' });
await page.waitForTimeout(2500);

admin.emit('admin:cmd', { type: 'ADD_BOT', count: 1 });
await new Promise((r) => setTimeout(r, 400));
admin.emit('admin:cmd', { type: 'START' });
console.log(`[${ts()}] START sent; polling every 2s for 40s`);

const shots = [];
let lastEntry = null;
let staleRun = 0;
const t0 = Date.now();
for (let i = 1; i <= 20; i++) {
  await page.waitForTimeout(2000);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const res = await page.evaluate(() => {
    const t = document.body.innerText || '';
    const a = t.match(/入水診断[^\n]*/);
    const b = t.match(/スクリーン診断[^\n]*/);
    return { entry: a ? a[0] : '(no entry-diagnosis line)', screenDiag: b ? b[0] : null };
  });
  const stale = res.entry === lastEntry;
  if (stale) staleRun += 1; else staleRun = 0;
  lastEntry = res.entry;
  const file = path.join(OUTDIR, `dpr${DPR}-poll${String(i).padStart(2, '0')}.png`);
  await page.screenshot({ path: file });
  shots.push(file);
  console.log(`[${ts()}] t=${elapsed}s ${res.entry}${stale ? ' [STALE x' + staleRun + ']' : ''}`);
  if (res.screenDiag) console.log(`[${ts()}] t=${elapsed}s ${res.screenDiag}`);
}

admin.close();
await browser.close();

// Luminance analysis method: pngjs decode, Rec.709 weights, sampling every 8th pixel.
console.log('--- mean luminance per PNG (pngjs, 0.2126R+0.7152G+0.0722B, every 8th pixel) ---');
for (const f of shots) {
  const png = PNG.sync.read(fs.readFileSync(f));
  let sum = 0;
  let n = 0;
  const d = png.data;
  for (let p = 0; p < d.length; p += 32) {
    sum += 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
    n += 1;
  }
  console.log(`${path.basename(f)} mean=${(sum / n).toFixed(2)}`);
}
console.log(`[${ts()}] run done`);
