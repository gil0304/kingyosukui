import Link from 'next/link';

const DEFAULT_ROOM = process.env.NEXT_PUBLIC_ROOM_ID ?? 'FESTIVAL01';

const card: React.CSSProperties = {
  display: 'block',
  padding: '22px 26px',
  border: '1px solid rgba(255,182,77,0.28)',
  borderRadius: 14,
  background: 'linear-gradient(160deg, rgba(21,26,48,0.92), rgba(13,16,32,0.92))',
  textDecoration: 'none',
  color: 'var(--ink)',
  minWidth: 260,
};

/** Landing page — the venue operator's index, not something players see. */
export default function Home() {
  return (
    <main
      style={{
        minHeight: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 34,
        padding: 40,
        background:
          'radial-gradient(120% 80% at 50% 0%, #1a2140 0%, #0a0c18 55%, #05060c 100%)',
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <h1
          className="jp-title"
          style={{ fontSize: 'clamp(30px, 6vw, 62px)', margin: 0, color: 'var(--lantern)' }}
        >
          巨大デジタル金魚すくい
        </h1>
        <p style={{ color: 'var(--ink-dim)', marginTop: 12, fontSize: 17 }}>
          スマホをポイにして、みんなで壁一面の金魚をすくう。
        </p>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, justifyContent: 'center' }}>
        <Link href={`/screen/${DEFAULT_ROOM}`} style={card}>
          <strong style={{ fontSize: 20 }}>巨大スクリーン</strong>
          <div style={{ color: 'var(--ink-dim)', marginTop: 8, fontSize: 14 }}>
            /screen/{DEFAULT_ROOM}
            <br />
            プロジェクター用。ブラウザを全画面にしてください。
          </div>
        </Link>

        <Link href={`/join/${DEFAULT_ROOM}`} style={card}>
          <strong style={{ fontSize: 20 }}>参加する（スマホ）</strong>
          <div style={{ color: 'var(--ink-dim)', marginTop: 8, fontSize: 14 }}>
            /join/{DEFAULT_ROOM}
            <br />
            通常はスクリーンのQRコードから開きます。
          </div>
        </Link>

        <Link href={`/admin?room=${DEFAULT_ROOM}`} style={card}>
          <strong style={{ fontSize: 20 }}>運営コンソール</strong>
          <div style={{ color: 'var(--ink-dim)', marginTop: 8, fontSize: 14 }}>
            /admin
            <br />
            開始・設定・接続状況。
          </div>
        </Link>
      </div>

      <p style={{ color: '#6d6656', fontSize: 13, maxWidth: 560, textAlign: 'center', lineHeight: 1.7 }}>
        モーションセンサーはHTTPS（またはlocalhost）でのみ利用できます。会場では
        <code style={{ color: 'var(--lantern)' }}> npm run start:https </code>
        で起動し、スマホでは自己署名証明書の警告を一度だけ承認してください。
      </p>
    </main>
  );
}
