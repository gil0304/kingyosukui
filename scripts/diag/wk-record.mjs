// Clean gameplay recording in headless WebKit (page video only, no desktop).
// Env: ROOM, SECS (default 40), OUT dir
import { webkit } from 'playwright';
import { io as ioc } from 'socket.io-client';

const ROOM = process.env.ROOM || `REC${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const SECS = Number(process.env.SECS || 40);
const OUT = process.env.OUT || '/tmp';

const browser = await webkit.launch();
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } },
});
const page = await context.newPage();

const admin = ioc('http://localhost:3000', { transports: ['websocket'], path: '/socket.io' });
await new Promise((r) => admin.on('connect', r));
admin.emit('admin:join', { roomId: ROOM });
await new Promise((r) => setTimeout(r, 300));
admin.emit('admin:cmd', { type: 'SETTINGS', settings: { highQuality: true } });
await new Promise((r) => setTimeout(r, 300));

await page.goto(`http://localhost:3000/screen/${ROOM}`, { waitUntil: 'load' });
await page.waitForTimeout(2500);
admin.emit('admin:cmd', { type: 'ADD_BOT', count: 2 });
await new Promise((r) => setTimeout(r, 400));
admin.emit('admin:cmd', { type: 'START' });
console.log(`recording ${SECS}s in room ${ROOM}`);
await page.waitForTimeout(SECS * 1000);

admin.close();
const video = page.video();
await page.close();
const path = await video.path();
await context.close();
await browser.close();
console.log(`video: ${path}`);
