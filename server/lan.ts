import os from 'node:os';

/**
 * The QR code on the giant screen has to point at an address the phones can
 * actually reach, which is almost never "localhost". Prefer private IPv4
 * ranges, and prefer Wi-Fi/Ethernet interfaces over virtual ones.
 */

const VIRTUAL_PREFIXES = ['vmnet', 'vboxnet', 'docker', 'br-', 'utun', 'awdl', 'llw', 'bridge'];

const isPrivateV4 = (ip: string): boolean =>
  /^10\./.test(ip) ||
  /^192\.168\./.test(ip) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

const score = (name: string, ip: string): number => {
  let s = 0;
  if (isPrivateV4(ip)) s += 100;
  if (/^en\d|^wlan|^wl|^Wi-Fi|^Ethernet/i.test(name)) s += 50;
  if (VIRTUAL_PREFIXES.some((p) => name.toLowerCase().startsWith(p))) s -= 200;
  if (/^192\.168\./.test(ip)) s += 10; // the most common home/venue router range
  return s;
};

export const getLanAddresses = (): string[] => {
  const found: { ip: string; s: number }[] = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      found.push({ ip: a.address, s: score(name, a.address) });
    }
  }
  return found.sort((a, b) => b.s - a.s).map((f) => f.ip);
};

export const primaryLanAddress = (): string => getLanAddresses()[0] ?? 'localhost';
