import { webkit } from 'playwright';
import { io as ioc } from 'socket.io-client';

const ROOM = 'WKROUND';
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(`http://localhost:3000/screen/${ROOM}?debug=1`, { waitUntil: 'load' });
await page.waitForTimeout(2500);

// Drive a round with a bot via the admin channel.
const admin = ioc('http://localhost:3000', { transports: ['websocket'], path: '/socket.io' });
await new Promise((r) => admin.on('connect', r));
admin.emit('admin:join', { roomId: ROOM });
await new Promise((r) => setTimeout(r, 400));
admin.emit('admin:cmd', { type: 'ADD_BOT', count: 1 });
await new Promise((r) => setTimeout(r, 400));
admin.emit('admin:cmd', { type: 'START' });

// calibration 3.2 + countdown 3.5 → play begins ~7s later; bot dunks after ~1-3s
await page.waitForTimeout(11000);
await page.screenshot({ path: process.env.SHOT1 || '/tmp/wk-play1.png' });
await page.waitForTimeout(2500);
await page.screenshot({ path: process.env.SHOT2 || '/tmp/wk-play2.png' });

const verdicts = await page.evaluate(() =>
  (window.__kingyoFrameHealth ? window.__kingyoFrameHealth.entries.map((e) => e.verdict) : null),
);
console.log('VERDICTS:', JSON.stringify(verdicts));
console.log('=== suspicious console lines ===');
for (const l of logs) {
  if (/error|Error|shader|Shader|Program|link|compile|WebGL/i.test(l)) console.log(l.slice(0, 1500));
}
admin.close();
await browser.close();
