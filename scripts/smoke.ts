/**
 * Venue smoke test.
 *
 * A scripted player joins the running server over the real Socket.IO transport,
 * waits for the round to start, hunts a fish, scoops it, then deliberately
 * yanks the poi around to wear the paper down, and finally checks the result
 * payload. It exercises the whole stack except the WebGL layer, which is why it
 * is worth running before doors open at an event.
 *
 *   npm run smoke                     (against http://localhost:3000)
 *   URL=https://192.168.1.20:3000 npm run smoke
 */
import { io, type Socket } from 'socket.io-client';
import { EV } from '@/network/protocol/events';
import { encodeInput, decodeFishPacket, decodePoiPacket } from '@/network/protocol/codec';
import { POI_BOUNDS, POI } from '@/game/core/constants';

const URL = process.env.URL ?? 'http://localhost:3000';
const ROOM = process.env.ROOM ?? 'E2ETEST';
const HALF_X = (POI_BOUNDS.maxX - POI_BOUNDS.minX) / 2;
const HALF_Z = (POI_BOUNDS.maxZ - POI_BOUNDS.minZ) / 2;
const CX = (POI_BOUNDS.maxX + POI_BOUNDS.minX) / 2;
const CZ = (POI_BOUNDS.maxZ + POI_BOUNDS.minZ) / 2;

const log: string[] = [];
const say = (s: string) => { log.push(s); console.log(s); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Fish = { id: number; x: number; y: number; z: number; type: string };
let fish: Fish[] = [];
let poi: { x: number; y: number; z: number; state: string; wetness: number; durability: number; carriedFish: number } | null = null;
/** Mutated from socket callbacks. Read it through phaseIs() so the compiler does not
 * narrow it to whatever we last checked for. */
const room = { phase: '' };
const phaseIs = (s: string): boolean => room.phase === s;
let fishPackets = 0, poiPackets = 0;
const captures: any[] = [];
const bowls: any[] = [];
let result: any = null;

async function main() {
  // --- screen -------------------------------------------------------------
  const screen: Socket = io(URL, { transports: ['websocket'], path: '/socket.io' });
  await new Promise<void>((res, rej) => {
    screen.on('connect', () => res());
    screen.on('connect_error', (e) => rej(e));
    setTimeout(() => rej(new Error('screen connect timeout')), 5000);
  });
  screen.emit(EV.SCREEN_JOIN, { roomId: ROOM });
  screen.on(EV.SNAPSHOT_FISH, (buf: ArrayBuffer) => {
    fishPackets++;
    const p = decodeFishPacket(buf instanceof ArrayBuffer ? buf : new Uint8Array(buf as any).buffer as ArrayBuffer);
    if (p) fish = p.fish.map((f) => ({ id: f.id, x: f.x, y: f.y, z: f.z, type: f.type }));
  });
  screen.on(EV.SNAPSHOT_POI, (buf: ArrayBuffer) => {
    poiPackets++;
    const p = decodePoiPacket(buf instanceof ArrayBuffer ? buf : new Uint8Array(buf as any).buffer as ArrayBuffer);
    if (p && p.poi[0]) poi = p.poi[0] as any;
  });
  screen.on(EV.PHASE, (p: any) => { if (p.state !== room.phase) { room.phase = p.state; say(`  phase -> ${room.phase}`); } });
  say('screen connected');

  // --- player -------------------------------------------------------------
  const player: Socket = io(URL, { transports: ['websocket'], path: '/socket.io' });
  await new Promise<void>((res, rej) => {
    player.on('connect', () => res());
    setTimeout(() => rej(new Error('player connect timeout')), 5000);
  });
  const ack: any = await new Promise((res) => player.emit(EV.PLAYER_JOIN, { roomId: ROOM }, res));
  say(`player join ack: ok=${ack.ok} seat=${ack.playerNumber} color=${ack.color} spectating=${ack.spectating}`);
  // Printed so a phone can be pointed at this seat to check the reconnect path:
  //   localStorage['kingyo.resume.<ROOM>'] = '<token>'  then reload /join/<ROOM>
  say(`resumeToken: ${ack.resumeToken}`);
  if (!ack.ok) throw new Error('join failed: ' + ack.reason);

  player.on(EV.EVENT_CAPTURE, (p: any) => { captures.push(p); say(`  CAPTURE P${p.playerNumber} ${p.fishLabel} +${p.score} (total ${p.totalScore}, ${p.fishCount}匹)`); });
  player.on(EV.BOWL_STATE, (p: any) => bowls.push(p));
  player.on(EV.EVENT_POI_BREAK, (p: any) => say(`  POI BREAK P${p.playerNumber} penalty ${p.penalty}`));
  player.on(EV.RESULT, (r: any) => { result = r; });
  player.on(EV.CALIBRATE_REQUEST, () => say('  calibrate request received'));

  player.emit(EV.PLAYER_READY, { controllerReady: true, status: { hasOrientation: true, hasMotion: true, gravityOnly: false } });
  player.emit(EV.CONTROLLER_CALIBRATED, { ok: true });

  // --- input pump ---------------------------------------------------------
  const inp = { x: 0, y: 0, submerge: false, lift: false, vel: 0, acc: 0, off: 0 };
  const pump = setInterval(() => {
    player.volatile.emit(EV.CONTROLLER_INPUT, encodeInput({
      timeMs: Date.now(), x: inp.x, y: inp.y,
      tiltX: inp.x * 0.55, tiltY: inp.y * 0.55, tiltZ: 0,
      verticalAcceleration: inp.acc, handOffsetY: inp.off, handVelocityY: inp.vel,
      liftPeakAccel: Math.abs(inp.acc), isSubmerging: inp.submerge, isLifting: inp.lift, shake: 0,
    }));
  }, 1000 / 60);

  // Never jump into a round that is already running: a spectator cannot play, and
  // the snapshot counters below would read zero for reasons that have nothing to do
  // with the server being healthy. Wait for the current round to finish first.
  const t0 = Date.now();
  if (phaseIs('PLAYING') || phaseIs('COUNTDOWN') || phaseIs('CALIBRATION')) {
    say('a round is already running — waiting for it to finish');
    while (!phaseIs('RESULT') && !phaseIs('WAITING') && Date.now() - t0 < 150000) await sleep(300);
  }
  say('waiting for the round to start (auto-start)...');
  while (!phaseIs('PLAYING') && Date.now() - t0 < 150000) await sleep(200);
  if (!phaseIs('PLAYING')) throw new Error('never reached PLAYING (phase=' + room.phase + ')');
  say(`snapshots so far: fish=${fishPackets} poi=${poiPackets}`);
  if (fishPackets === 0) throw new Error('no fish snapshots reached the screen');
  if (poiPackets === 0) throw new Error('no poi snapshots reached the screen');
  say(`fish in tank: ${fish.length}`);

  // --- hunt ---------------------------------------------------------------
  let attempts = 0;
  while (captures.length === 0 && attempts < 14 && phaseIs('PLAYING')) {
    attempts++;
    // pick the fish nearest the poi that is reachable
    const px = poi?.x ?? 0, pz = poi?.z ?? 0;
    const reach = fish.filter((f) => f.x > POI_BOUNDS.minX && f.x < POI_BOUNDS.maxX && f.z > POI_BOUNDS.minZ && f.z < POI_BOUNDS.maxZ);
    if (!reach.length) { await sleep(200); continue; }
    reach.sort((a, b) => Math.hypot(a.x - px, a.z - pz) - Math.hypot(b.x - px, b.z - pz));
    const target = reach[0]!;

    // Get under it (fish flee, so keep re-aiming).
    inp.submerge = true; inp.lift = false; inp.off = -0.09; inp.acc = -3.5; inp.vel = -0.3;
    for (let i = 0; i < 90; i++) {
      const cur = fish.find((f) => f.id === target.id);
      const tx = cur ? cur.x : target.x, tz = cur ? cur.z : target.z;
      inp.x = Math.max(-1, Math.min(1, (tx - CX) / HALF_X));
      inp.y = Math.max(-1, Math.min(1, (tz - CZ) / HALF_Z));
      await sleep(16);
      if (poi && poi.carriedFish > 0) break;
    }
    if (!poi || poi.carriedFish === 0) { continue; }

    say(`  fish on the paper (attempt ${attempts}) — lifting gently`);
    inp.submerge = false; inp.lift = true; inp.off = 0.1; inp.acc = 3.4; inp.vel = 0.45;
    for (let i = 0; i < 160 && captures.length === 0; i++) await sleep(16);
    inp.lift = false; inp.acc = 0; inp.vel = 0; inp.off = 0;
    await sleep(400);
  }

  say(`attempts: ${attempts}, captures: ${captures.length}`);
  const lastBowl = bowls[bowls.length - 1];
  say(`bowl: score=${lastBowl?.score} fish=${lastBowl?.capturedFish?.length} durability=${lastBowl?.poiDurability?.toFixed(1)} wetness=${lastBowl?.poiWetness?.toFixed(2)} state=${lastBowl?.poiState}`);

  // --- violent yank should hurt the paper ---------------------------------
  const durBefore = lastBowl?.poiDurability ?? 100;
  for (let k = 0; k < 6; k++) {
    inp.submerge = true; inp.lift = false; inp.off = -0.09; inp.acc = -4;
    await sleep(700);
    inp.submerge = false; inp.lift = true; inp.off = 0.12; inp.acc = 30; inp.vel = 3;
    await sleep(700);
    inp.lift = false; inp.acc = 0; inp.vel = 0;
    await sleep(200);
    if (!phaseIs('PLAYING')) break;
  }
  const afterBowl = bowls[bowls.length - 1];
  say(`after yanking: durability ${durBefore.toFixed(1)} -> ${afterBowl?.poiDurability?.toFixed(1)} wetness ${afterBowl?.poiWetness?.toFixed(2)} breaks=${afterBowl?.poiState}`);

  say('waiting for TIME UP...');
  const t1 = Date.now();
  while (!phaseIs('RESULT') && Date.now() - t1 < 100000) await sleep(300);
  await sleep(600);
  say(`phase=${room.phase} result=${result ? 'received' : 'MISSING'}`);
  if (result) {
    for (const r of result.rankings) say(`  ${r.rank}. PLAYER ${r.number}  ${r.score}pt  ${r.fishCount}匹  best=${r.bestFish ? r.bestFish.fishType : '-'}`);
    for (const a of result.awards) say(`  award ${a.label}: P${a.playerNumber} (${a.detail})`);
  }

  if (process.env.KEEP === '1') {
    say('KEEP=1: holding the connection open so the seat can be reclaimed elsewhere.');
    await new Promise(() => {});
  }

  clearInterval(pump);
  screen.close();
  player.close();

  const ok = captures.length > 0 && !!result && fishPackets > 0 && poiPackets > 0;
  say(ok ? '\nE2E PASS' : '\nE2E FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('E2E ERROR', e); process.exit(1); });
