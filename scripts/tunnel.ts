/**
 * 一時公開: トンネルで本番サーバーをインターネットへ出す。
 *
 *   npm run tunnel                       # cloudflared があればそれを優先
 *   TUNNEL=ngrok npm run tunnel          # ngrok を強制
 *   ROOM_ID=MATSURI PORT=3000 npm run tunnel
 *   NGROK_DOMAIN=my-name.ngrok-free.app npm run tunnel   (ngrok予約ドメイン)
 *
 * トンネルが TLS を終端するので、スマホは正規の証明書で HTTPS 接続でき、
 * 自己署名証明書の警告なしにモーションセンサーの許可が取れる。これが
 * このコマンドの存在理由で、単なるリモート公開のおまけではない。
 *
 * 既定は Cloudflare Quick Tunnel (cloudflared)。ngrok の無料プランは
 * ブラウザ確認ページ(interstitial)を挟み、そのページの cookie を持たない
 * 端末では JS/CSS のリクエストにまで HTML が返る — 実機で
 * 「SyntaxError: Unexpected token '<'」としてアプリの起動を壊すことを確認済み。
 * cloudflared にはこの仕組みが無く、アカウントも不要。
 *
 * どちらもインターネット往復のぶん遅延が増える（体感 +30〜150ms）。
 * プロジェクターの表示だけはローカルで済ませる「ハイブリッド構成」の URL も
 * 出力するので、会場では基本そちらを使う。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const port = Number(process.env.PORT ?? 3000);
const roomId = (process.env.ROOM_ID ?? 'FESTIVAL01').toUpperCase();
const reservedDomain = process.env.NGROK_DOMAIN;

type Provider = 'cloudflared' | 'ngrok';

const hasCommand = (cmd: string): boolean => {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
};

const pickProvider = (): Provider => {
  const forced = (process.env.TUNNEL ?? '').toLowerCase();
  if (forced === 'ngrok' || forced === 'cloudflared') return forced;
  // NGROK_DOMAIN is an explicit ngrok choice even without TUNNEL=ngrok.
  if (reservedDomain) return 'ngrok';
  if (hasCommand('cloudflared')) return 'cloudflared';
  return 'ngrok';
};

const line = '─'.repeat(64);
const say = (s: string) => console.log(s);
const die = (s: string): never => {
  console.error(`\n  ✗ ${s}\n`);
  process.exit(1);
};

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

if (!fs.existsSync(path.join(process.cwd(), '.next'))) {
  die('本番ビルドが見つかりません。先に  npm run build  を実行してください。');
}

const provider = pickProvider();

if (provider === 'cloudflared' && !hasCommand('cloudflared')) {
  die(
    [
      'cloudflared が見つかりません。インストールしてください:',
      '',
      '    brew install cloudflared',
      '',
      'または ngrok を使う場合:  TUNNEL=ngrok npm run tunnel',
    ].join('\n  '),
  );
}
if (provider === 'ngrok') {
  const r = spawnSync('ngrok', ['version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    die(
      [
        'ngrok が見つかりません。インストールと認証を済ませてください:',
        '',
        '    brew install ngrok            # または https://ngrok.com/download',
        '    ngrok config add-authtoken <トークン>   # https://dashboard.ngrok.com',
        '',
        '推奨は cloudflared です（確認ページが無く、アカウント不要）:',
        '    brew install cloudflared',
      ].join('\n  '),
    );
  }
}

// ---------------------------------------------------------------------------
// children
// ---------------------------------------------------------------------------

const children: ChildProcess[] = [];
let shuttingDown = false;

const shutdown = (code: number): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try {
      c.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  // A stubborn child gets three seconds, then the whole group exits anyway.
  setTimeout(() => process.exit(code), 3000).unref();
  let waiting = children.filter((c) => c.exitCode === null).length;
  if (waiting === 0) process.exit(code);
  for (const c of children) {
    c.once('exit', () => {
      waiting--;
      if (waiting <= 0) process.exit(code);
    });
  }
};

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// --- 1. the game server (plain HTTP — ngrok terminates TLS) ----------------

say(`\n${line}\n  巨大デジタル金魚すくい — 一時公開 (${provider})\n${line}`);
say('  ローカルサーバーを起動しています…');

const server = spawn('npx', ['tsx', 'server/index.ts'], {
  env: { ...process.env, NODE_ENV: 'production', HTTPS: '0', PORT: String(port), ROOM_ID: roomId },
  stdio: ['ignore', 'pipe', 'inherit'],
});
children.push(server);
server.on('exit', (code) => {
  if (!shuttingDown) {
    console.error(`\n  ✗ ゲームサーバーが終了しました (code ${code})。ポート ${port} が既に使われていないか確認してください。`);
    shutdown(1);
  }
});

const serverReady = new Promise<void>((resolve) => {
  const rl = readline.createInterface({ input: server.stdout! });
  rl.on('line', (l) => {
    if (l.includes('server ready')) resolve();
    // The local banner would only bury the public URLs; swallow it.
  });
});

// --- 2. the tunnel ----------------------------------------------------------

/**
 * Cloudflare Quick Tunnel: no account, no browser interstitial, a real
 * certificate on *.trycloudflare.com. The URL is announced on stderr.
 */
const startCloudflared = (): { proc: ChildProcess; url: Promise<string> } => {
  const proc = spawn(
    'cloudflared',
    ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(proc);

  const url = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('cloudflared が 30 秒以内にトンネル URL を返しませんでした')),
      30000,
    );
    let buf = '';
    const scan = (chunk: Buffer): void => {
      buf += chunk.toString();
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    };
    proc.stdout!.on('data', scan);
    proc.stderr!.on('data', scan);
    proc.on('exit', (code) => {
      if (!shuttingDown) {
        clearTimeout(timer);
        reject(new Error(`cloudflared が終了しました (code ${code})`));
      }
    });
  });

  return { proc, url };
};

const startNgrok = (): { proc: ChildProcess; url: Promise<string> } => {
  const args = ['http', String(port), '--log=stdout', '--log-format=json'];
  if (reservedDomain) args.push(`--domain=${reservedDomain}`);
  const proc = spawn('ngrok', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(proc);

  const url = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('ngrok が 20 秒以内にトンネル URL を返しませんでした')),
      20000,
    );
    const rl = readline.createInterface({ input: proc.stdout! });
    rl.on('line', (l) => {
      // JSON log: the tunnel-started event carries {"url":"https://…"}
      try {
        const j = JSON.parse(l) as { url?: string; msg?: string; err?: string };
        if (j.url && j.url.startsWith('https://')) {
          clearTimeout(timer);
          resolve(j.url);
        }
        if (j.err && j.err !== '<nil>') {
          clearTimeout(timer);
          reject(new Error(j.err));
        }
      } catch {
        /* non-JSON line */
      }
    });
    let stderrBuf = '';
    proc.stderr!.on('data', (d: Buffer) => (stderrBuf += d.toString()));
    proc.on('exit', (code) => {
      if (!shuttingDown) {
        clearTimeout(timer);
        reject(
          new Error(
            `ngrok が終了しました (code ${code})。${stderrBuf.trim() || '認証トークンが未設定の可能性があります: ngrok config add-authtoken <トークン>'}`,
          ),
        );
      }
    });
  });

  return { proc, url };
};

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await serverReady;
  say(`  トンネルを開いています… (${provider})`);

  const { url } = provider === 'cloudflared' ? startCloudflared() : startNgrok();
  let publicUrl: string;
  try {
    publicUrl = await url;
  } catch (e) {
    die((e as Error).message);
    return;
  }

  const host = publicUrl.replace(/^https:\/\//, '');
  say(`\n${line}`);
  say('  公開中 — このURLはプロセスを止めるまで有効です (Ctrl+C で終了)');
  say(line);
  say('  すべて公開URL経由（リモートデモ向け・一番かんたん）');
  say(`    SCREEN  ${publicUrl}/screen/${roomId}`);
  say(`    JOIN    ${publicUrl}/join/${roomId}   ← QRはこのURLになる`);
  say(`    ADMIN   ${publicUrl}/admin?room=${roomId}`);
  say(line);
  say('  会場向けハイブリッド（推奨: スクリーンはローカル、スマホだけ公開URL）');
  say(`    SCREEN  http://localhost:${port}/screen/${roomId}?join=${host}`);
  say('            (?join=… がQRの向き先を公開URLに差し替えます)');
  say(`    ADMIN   http://localhost:${port}/admin?room=${roomId}`);
  say(line);
  say('  メモ');
  say('    ・スマホは正規のHTTPS証明書で接続するため、警告なしでセンサー許可が出ます');
  if (provider === 'ngrok') {
    say('    ・【注意】ngrok無料プランは確認ページを挟みます。確認ページのcookieが');
    say('      無い端末ではJS/CSSにHTMLが返り、アプリが起動できないことがあります。');
    say('      スマホで使う本番は cloudflared を推奨:  brew install cloudflared');
  } else {
    say('    ・Cloudflare Quick Tunnel: 確認ページなし・アカウント不要です');
  }
  say('    ・インターネット経由のぶん遅延が増えます。最低遅延が欲しい本番は');
  say('      同一LAN + npm run start:https（自己署名証明書）を使ってください');
  say(`${line}\n`);
}

main().catch((e) => die(String(e)));
