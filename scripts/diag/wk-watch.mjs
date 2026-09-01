// Continuous black-frame watch in headless WebKit using the v2 probe.
// Env: ROOM (default auto), SECS (default 90), DPR (default 2), BOTS (default 2),
//      QS (extra query string, e.g. "&fx=0" or "&splash=0")
import { webkit } from 'playwright';
import { io as ioc } from 'socket.io-client';

const ROOM = process.env.ROOM || `WKW${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const SECS = Number(process.env.SECS || 90);
const DPR = Number(process.env.DPR || 2);
const BOTS = Number(process.env.BOTS || 2);
const QS = process.env.QS || '';

const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: DPR });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('kingyo')) console.log('[console]', t);
});

const admin = ioc('http://localhost:3000', { transports: ['websocket'], path: '/socket.io' });
await new Promise((r) => admin.on('connect', r));
admin.emit('admin:join', { roomId: ROOM });
await new Promise((r) => setTimeout(r, 300));
admin.emit('admin:cmd', { type: 'SETTINGS', settings: { highQuality: true } });
await new Promise((r) => setTimeout(r, 300));

await page.goto(`http://localhost:3000/screen/${ROOM}?debug=1${QS}`, { waitUntil: 'load' });
await page.waitForTimeout(3000);

admin.emit('admin:cmd', { type: 'ADD_BOT', count: BOTS });
await new Promise((r) => setTimeout(r, 400));
admin.emit('admin:cmd', { type: 'START' });
console.log(`ROOM=${ROOM} DPR=${DPR} BOTS=${BOTS} QS="${QS}" watching ${SECS}s`);

const deadline = Date.now() + SECS * 1000;
while (Date.now() < deadline) {
  await page.waitForTimeout(5000);
  // Restart the round when it ends so entries keep flowing.
  const state = await page.evaluate(() => {
    const m = (document.body.innerText || '').match(/state\s*(\w+)/);
    return m ? m[1] : '?';
  });
  if (state === 'RESULT' || state === 'LOBBY') {
    admin.emit('admin:cmd', { type: 'START' });
  }
}

const report = await page.evaluate(() => {
  const h = window.__kingyoFrameHealth;
  if (!h) return null;
  return {
    counters: h.counters,
    blackLog: h.blackLog,
    entries: h.entries,
    events: h.events,
    programs: h.programs(),
    loopSkew: h.loopSkew(),
  };
});
console.log('=== REPORT ===');
if (report) {
  console.log('counters:', JSON.stringify(report.counters));
  console.log('programs:', report.programs, 'loopSkew:', report.loopSkew);
  for (const b of report.blackLog) {
    console.log(`BLACK t=${Math.round(b.t)} 場所=${b.where} 輝度=${b.lum} 直前=${b.prevEvent}`);
    if (b.map) for (const row of b.map) console.log('  ' + row);
  }
  console.log('entries:', JSON.stringify(report.entries.map((e) => e.verdict)));
} else {
  console.log('no health handle');
}
admin.close();
await browser.close();
