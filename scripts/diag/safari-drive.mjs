// Drive a screen room for live-Safari diagnosis: settings, bots, start.
// Env: ROOM (default SAFENTRY), BOTS (default 2)
import { io as ioc } from 'socket.io-client';
const ROOM = process.env.ROOM || 'SAFENTRY';
const BOTS = Number(process.env.BOTS || 2);
const admin = ioc('http://localhost:3000', { transports: ['websocket'], path: '/socket.io' });
await new Promise((r) => admin.on('connect', r));
admin.emit('admin:join', { roomId: ROOM });
await new Promise((r) => setTimeout(r, 300));
admin.emit('admin:cmd', { type: 'SETTINGS', settings: { highQuality: true } });
await new Promise((r) => setTimeout(r, 300));
admin.emit('admin:cmd', { type: 'ADD_BOT', count: BOTS });
await new Promise((r) => setTimeout(r, 400));
admin.emit('admin:cmd', { type: 'START' });
console.log(`room=${ROOM} bots=${BOTS} started`);
admin.close();
