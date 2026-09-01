import { webkit } from 'playwright';
import { io as ioc } from 'socket.io-client';

const ROOM = process.env.ROOM || 'WKBISECT';
const HQ = process.env.HQ !== '0';

const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

const admin = ioc('http://localhost:3000', { transports: ['websocket'], path: '/socket.io' });
await new Promise((r) => admin.on('connect', r));
admin.emit('admin:join', { roomId: ROOM });
await new Promise((r) => setTimeout(r, 300));
admin.emit('admin:cmd', { type: 'SETTINGS', settings: { highQuality: HQ } });
await new Promise((r) => setTimeout(r, 300));

await page.goto(`http://localhost:3000/screen/${ROOM}?debug=1`, { waitUntil: 'load' });
await page.waitForTimeout(2500);

admin.emit('admin:cmd', { type: 'ADD_BOT', count: 1 });
await new Promise((r) => setTimeout(r, 400));
admin.emit('admin:cmd', { type: 'START' });

// Let the bot dunk several times.
await page.waitForTimeout(24000);

const overlay = await page.evaluate(() => {
  const m = (document.body.innerText || '').match(/入水診断[^\n]*/);
  return m ? m[0] : 'not found';
});
console.log(`HQ=${HQ} → ${overlay}`);
admin.close();
await browser.close();
