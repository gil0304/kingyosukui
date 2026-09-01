/**
 * Single-process venue server: Next.js and Socket.IO share one port so the QR
 * code only ever needs one origin.
 *
 *   npm run dev          http  on 3000
 *   npm run dev:https    https on 3000 with a self-signed cert
 *
 * HTTPS matters in practice: iOS and Chrome only expose DeviceMotion /
 * DeviceOrientation in a secure context, so on a venue LAN (no DNS, no public
 * cert) the choice is a self-signed certificate or a tunnel.
 */

import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import next from 'next';
import { Server } from 'socket.io';

import { RoomManager } from '../src/network/rooms/RoomManager';
import { ensureCertificate } from './certs';
import { getLanAddresses, primaryLanAddress } from './lan';

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? '0.0.0.0';
const useHttps = process.env.HTTPS === '1' || process.env.HTTPS === 'true';
const defaultRoom = (process.env.ROOM_ID ?? 'FESTIVAL01').toUpperCase();

const app = next({ dev, hostname: hostname === '0.0.0.0' ? 'localhost' : hostname, port });
const handle = app.getRequestHandler();

const banner = (scheme: string): void => {
  const ip = primaryLanAddress();
  const all = getLanAddresses();
  const base = `${scheme}://${ip}:${port}`;
  const line = '─'.repeat(64);
  /* eslint-disable no-console */
  console.log(`\n${line}`);
  console.log('  巨大デジタル金魚すくい  —  server ready');
  console.log(line);
  console.log(`  SCREEN   ${base}/screen/${defaultRoom}`);
  console.log(`  JOIN     ${base}/join/${defaultRoom}   (the QR on screen points here)`);
  console.log(`  ADMIN    ${base}/admin?room=${defaultRoom}`);
  console.log(line);
  if (all.length > 1) console.log(`  other addresses: ${all.slice(1).join(', ')}`);
  if (!useHttps) {
    console.log('  NOTE  iOS/Chrome expose motion sensors only over HTTPS.');
    console.log('        Phones will not be able to grant sensor permission on plain http');
    console.log('        unless you reach the page via localhost. Use: npm run dev:https');
  } else {
    console.log('  NOTE  self-signed certificate: accept the warning once on each phone.');
  }
  console.log(`${line}\n`);
  /* eslint-enable no-console */
};

async function main(): Promise<void> {
  await app.prepare();

  const requestListener = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void => {
    handle(req, res).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('request failed', err);
      res.statusCode = 500;
      res.end('internal error');
    });
  };

  const server = useHttps
    ? https.createServer(ensureCertificate(path.join(process.cwd(), 'certs')), requestListener)
    : http.createServer(requestListener);

  const io = new Server(server, {
    path: '/socket.io',
    // Poll fallback keeps flaky venue Wi-Fi usable; WebSocket is tried first.
    transports: ['websocket', 'polling'],
    cors: { origin: true, credentials: true },
    // 60 Hz input packets are tiny; keep the buffer small so a stalled phone
    // cannot balloon memory.
    maxHttpBufferSize: 1e5,
    pingInterval: 5000,
    pingTimeout: 8000,
  });

  const rooms = new RoomManager(io);
  io.on('connection', (socket) => rooms.bind(socket));

  server.listen(port, hostname, () => banner(useHttps ? 'https' : 'http'));

  const shutdown = (): void => {
    rooms.dispose();
    io.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
