import fs from 'node:fs';
import path from 'node:path';
import selfsigned from 'selfsigned';
import { getLanAddresses } from './lan';

/**
 * iOS and Chrome only expose DeviceMotion/DeviceOrientation in a *secure
 * context*. At a venue there is no public DNS name, so the practical option is
 * a self-signed certificate that covers localhost plus every LAN address of
 * this machine. Players accept the warning once; sensors then work.
 *
 * Certificates are cached in ./certs and regenerated when the machine's LAN
 * addresses change (e.g. moving to the venue's Wi-Fi).
 */

export interface Certificate {
  key: string;
  cert: string;
}

const CERT_FILE = 'server.cert';
const KEY_FILE = 'server.key';
const META_FILE = 'server.meta.json';

export const ensureCertificate = (dir: string): Certificate => {
  fs.mkdirSync(dir, { recursive: true });
  const certPath = path.join(dir, CERT_FILE);
  const keyPath = path.join(dir, KEY_FILE);
  const metaPath = path.join(dir, META_FILE);

  const addresses = getLanAddresses();
  const fingerprint = JSON.stringify(addresses);

  if (fs.existsSync(certPath) && fs.existsSync(keyPath) && fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
        fingerprint: string;
        expiresAt: number;
      };
      if (meta.fingerprint === fingerprint && meta.expiresAt > Date.now()) {
        return {
          key: fs.readFileSync(keyPath, 'utf8'),
          cert: fs.readFileSync(certPath, 'utf8'),
        };
      }
    } catch {
      // fall through and regenerate
    }
  }

  const days = 397; // the maximum most clients accept for a leaf certificate
  const altNames: { type: number; value?: string; ip?: string }[] = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    { type: 7, ip: '::1' },
    ...addresses.map((ip) => ({ type: 7, ip })),
  ];

  const pems = selfsigned.generate([{ name: 'commonName', value: 'kingyosukui.local' }], {
    days,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true },
      {
        name: 'keyUsage',
        keyCertSign: true,
        digitalSignature: true,
        keyEncipherment: true,
      },
      { name: 'subjectAltName', altNames },
    ],
  });

  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(
    metaPath,
    JSON.stringify({ fingerprint, expiresAt: Date.now() + (days - 7) * 86400_000 }, null, 2),
  );

  return { key: pems.private, cert: pems.cert };
};
