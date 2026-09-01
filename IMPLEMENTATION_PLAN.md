# 巨大デジタル金魚すくい — IMPLEMENTATION PLAN

> スマホをポイにして、みんなで壁一面の金魚をすくう。

本書は仕様書（§0–§134）に対する実装計画である。仕様の簡略化（§129 禁止事項）は行わない。
操作は **必ず端末モーションセンサー**、水槽は **全員共有の 1 つ**、金魚は **3D メッシュ**、水は
**専用シェーダー**、スマホには **自分だけの金魚ボウル**。

---

## 1. Architecture

3 種類のクライアントと 1 つの権威サーバーで構成する。

```
PLAYER 1 Smartphone ─┐        (controller input 60Hz, binary)
PLAYER 2 Smartphone ─┤
PLAYER 3 Smartphone ─┼── Socket.IO ── Game Server (Node.js)
PLAYER 4 Smartphone ─┘                 │  authoritative 60Hz tick
                                       │  ├ RoomManager / lifecycle
Admin Browser ─────────────────────────┤  ├ PoiSimulation
                                       │  ├ FishSimulation (Boids)
                                       │  ├ CaptureArbiter
                                       ▼  └ Scoring
                              Big Screen Browser
                                       │  snapshot(fish 30Hz) + poi(60Hz)
                                       ▼
                            Three.js / React Three Fiber
                                       │
                                       ▼
                                 Huge Fish Tank
```

### 権威分担（§82, §83 Server Authoritative）

| 対象 | 権威 | 理由 |
|---|---|---|
| Room / RoomState / GameTime | Server | 全クライアント同期 |
| Player / Score / CapturedFish | Server | 不正・競合排除 |
| **Poi の位置・傾き・耐久** | Server | 複数ポイ衝突と捕獲判定を 1 箇所で解決 |
| **Fish の位置・AI・所有権** | Server | 同一金魚の取り合い（§14, §82）を厳密判定 |
| 水面・波紋・粒子・音・演出 | Screen client | 見た目のみ。権威不要 |
| Bowl 内の金魚の泳ぎ | Phone client | ローカル演出。中身（CapturedFish[]）はサーバー由来 |

**クライアント単独の捕獲判定は行わない（§82）。** 画面側は「サーバーが送ってきた事実」を
演出するだけ。

### レイテンシ設計（§39 体感 100ms 以下）

felt latency = 端末サンプリング + 送信 + サーバー tick + 配信 + 描画。

- 端末 60Hz サンプリング → 約 16ms
- LAN Socket.IO 片道 → 約 3–15ms
- サーバー tick 60Hz → 約 8ms 平均
- **Poi は 60Hz で単独パケット配信**（魚と同梱しない）。魚の 30Hz 補間遅延を
  ポイが被らないようにするのが要点。
- 画面側はポイに 45ms の軽い平滑のみ、魚には 75ms の補間遅延。

合計 **約 45–70ms**。目標を満たす。

---

## 2. Directory Structure

仕様 §119 に準拠（実装で必要な追加のみ拡張）。

```
kingyosukui/
├─ IMPLEMENTATION_PLAN.md
├─ README.md                      # 会場設営・起動手順
├─ server/
│  ├─ index.ts                    # Next.js + Socket.IO 統合サーバー (HTTP/HTTPS)
│  ├─ certs.ts                    # 自己署名証明書生成（iOS のセンサーは secure context 必須）
│  └─ lan.ts                      # LAN IP 検出 → QR 用 URL
├─ src/
│  ├─ app/
│  │  ├─ page.tsx                 # ランディング（/screen /join /admin への導線）
│  │  ├─ screen/[roomId]/page.tsx # 巨大スクリーン
│  │  ├─ join/[roomId]/page.tsx   # スマートフォン
│  │  └─ admin/page.tsx           # 運営コンソール
│  ├─ game/
│  │  ├─ core/       constants.ts math.ts
│  │  ├─ fish/       fishTypes.ts fishSimulation.ts boids.ts fishGeometry.ts fishAnimation.ts
│  │  ├─ poi/        poiSimulation.ts poiGeometry.ts durability.ts
│  │  ├─ water/      waterSurface.tsx caustics.ts rippleField.ts
│  │  ├─ scoring/    scoring.ts
│  │  ├─ lifecycle/  roomLifecycle.ts
│  │  └─ environment/ FestivalStall.tsx Lanterns.tsx lighting.tsx
│  ├─ controller/
│  │  ├─ sensors/    permission.ts sensorAdapter.ts
│  │  ├─ calibration/ calibrator.ts
│  │  ├─ filtering/  filters.ts
│  │  └─ gestures/   gestureDetector.ts
│  ├─ network/
│  │  ├─ protocol/   events.ts codec.ts
│  │  ├─ socket/     useScreenSocket.ts useControllerSocket.ts useAdminSocket.ts
│  │  ├─ rooms/      RoomManager.ts GameRoom.ts (server-only)
│  │  └─ state/      snapshotBuffer.ts
│  ├─ rendering/
│  │  ├─ materials/  waterMaterial.ts fishMaterial.ts poiPaperMaterial.ts
│  │  ├─ shaders/    *.glsl.ts
│  │  ├─ particles/  Splash.tsx Droplets.tsx Bubbles.tsx
│  │  └─ postprocessing/ Effects.tsx
│  ├─ smartphone/
│  │  ├─ bowl/       BowlCanvas.tsx bowlSimulation.ts bowlFishRenderer.ts
│  │  ├─ status/     StatusBar.tsx PoiStatus.tsx
│  │  └─ result/     PhoneResult.tsx
│  ├─ audio/         AudioEngine.ts sfx.ts ambience.ts
│  ├─ components/    QRPanel.tsx Countdown.tsx ScoreBoard.tsx ...
│  ├─ types/         ids.ts fish.ts player.ts room.ts controller.ts index.ts
│  └─ utils/
```

**重要な制約**: `src/game/core/*`, `src/game/fish/fishSimulation.ts`, `boids.ts`,
`src/game/poi/poiSimulation.ts`, `durability.ts`, `src/game/scoring/*`,
`src/network/protocol/*` は **`three` を import しない**。Node のサーバーで
そのまま動く純 TypeScript に保つ。

---

## 3. Network Structure

### 3.1 トランスポート
Socket.IO（WebSocket 優先、polling フォールバック）。Next.js と同一ポート・同一オリジンで
起動するカスタムサーバー（`server/index.ts`）。QR の URL が 1 つで済む。

### 3.2 バイナリパケット（`src/network/protocol/codec.ts`）
高頻度データは JSON を使わない。little-endian 固定小数点。

| Packet | 方向 | 周期 | サイズ |
|---|---|---|---|
| `FISH` (id 1) | server → screen | 30Hz | 12 + 16×N（200匹で 3.2KB / 96KB·s⁻¹） |
| `POI` (id 2) | server → screen | 60Hz | 12 + 20×P |
| `INPUT` (id 10) | phone → server | 60Hz | 26B |

位置 = i16 × 1/1000 単位、角度 = i16 × 1/5000 rad。

### 3.3 JSON イベント（低頻度）
`room:state` / `game:phase` / `ev:capture` / `ev:drop` / `ev:break` / `ev:respawn` /
`ev:splash` / `ev:joined` / `ev:left` / `ev:rare` / `bowl:state` / `game:result`。
名前は `src/network/protocol/events.ts` の `EV` に集約。

### 3.4 切断・再接続（§84）
- 切断 → そのプレイヤーのポイは即停止（入力ゼロ）、他プレイヤーは継続。
- 3 秒の猶予（`GAME.reconnectGraceSeconds`）。`resumeToken` で同じ席に復帰。
- 復帰しなければ退出、ポイは水槽から引き上げる演出。

### 3.5 途中参加（§85）
`PLAYING`/`COUNTDOWN` 中の新規参加は `spectating: true` で受理し、
スマホに「次のゲームに参加します」を表示。次の `WAITING` で自動的に本参加。

---

## 4. Screen Client

`/screen/[roomId]`。フルスクリーン前提。

- **Canvas**: R3F。カメラ `position (0, 4.35, 9.15)`, `lookAt (0,-0.55,0)`, fov 42。
  水槽が画面の 85–90% を占める（§99）。
- **レイヤー**
  1. 環境（屋台の木枠・赤い布・提灯・看板・暖色照明）
  2. 水中（砂利・水草・石・泡・Caustics）
  3. 金魚（InstancedMesh + LOD）
  4. ポイ（最大 8 本、個別 mesh）
  5. 水面（ShaderMaterial：屈折・反射・Fresnel・波紋・法線歪み）
  6. 粒子（水しぶき・水滴・波紋リング）
  7. ポストプロセス（Bloom 弱め、Vignette）
  8. HUD（DOM オーバーレイ：スコア・残り時間・QR・フェーズ演出）
- **状態**: `snapshotBuffer` に FISH パケットを溜め、`t - 75ms` で線形補間。
  POI は 45ms 平滑のみ。
- **デバッグ入力（§120）**: `?debug=1` でマウス／キーボードのポイ操作を有効化。
  これは開発専用であり完成形の操作方式ではない。

---

## 5. Smartphone Client

`/join/[roomId]`。

1. **初期画面（§20）**: タイトル + 「参加する」ボタンのみ。
   タップで `DeviceOrientationEvent.requestPermission()` /
   `DeviceMotionEvent.requestPermission()` を要求（iOS 13+ はユーザー操作必須）。
2. **キャリブレーション（§28, §29）**: 巨大スクリーンの 3・2・1 に同期して
   自動で neutral 姿勢を取得。**スマホ側に操作ボタンは無い。**
3. **プレイ中（§21–§24）**:
   - 操作 UI は一切無し（仮想スティック・すくうボタン・タップ捕獲は禁止 §23）。
   - 表示は「Player 番号 / スコア / 捕獲数 / **自分専用の金魚ボウル** / ポイ状態 / 接続状態」。
   - 画面に触ると有利になる要素はゼロ。
4. **ポイ破損時（§96）**: ボウルは消さず「ポイがやぶれた！ 3・2・1」を重ねる。
5. **結果（§106）**: 自分のスコア・匹数・BEST FISH・自分のボウル。

`wakeLock` を取得して画面が消えないようにする。`touch-action: none`, `overscroll-behavior: none`。

---

## 6. Sensor Handling

```
DeviceOrientationEvent ─┐
DeviceMotionEvent ──────┴─> SensorAdapter ─> Calibration ─> Filtering ─> Gestures ─> ControllerState
```

### 6.1 SensorAdapter（§26）
生の値をゲームへ直接渡さない。端末差（画面向き、iOS の符号反転、
`acceleration` が null で `accelerationIncludingGravity` しか無い端末）を吸収し、
**デバイス座標 → プレイヤー座標** に変換する。

**傾きは beta/gamma ではなく重力ベクトルから計算する。** DeviceOrientation の
オイラー角は端末・プラットフォームで規約が揺れ、Android の多くは地磁気フュージョン
（会場はスピーカーと鉄骨だらけ）で漂う。加速度計の重力方向だけが全端末で一致する。
キャリブレーション時に重力の半球符号（iOS の反転規約）を固定し、以後は
中立姿勢とのロール・ピッチ差分を傾きとする。

- 画面回転 (`screen.orientation.angle`) を補正。
- `acceleration` が無い端末は、重力を低域通過フィルタで推定し
  `linear = includingGravity - gravity` を自前計算（`gravityOnly` フラグを立てる）。
- 重力方向から **ワールド上方向成分の加速度** を求める → `verticalAcceleration`。

### 6.2 Calibration（§28）
巨大スクリーンの「スマホを自然に構えてください 3・2・1」の間、
`beta/gamma/alpha` と重力ベクトルを平均して `NeutralOrientation` を保存。
以降 `Current - Neutral` を使用。ボタン不要（§29）。
プレイ中も、長時間ほぼ静止した姿勢はごく弱く neutral へドリフト補正する
（手首の疲れによるずれ対策。移動入力を殺さないよう時定数は 25 秒と非常に長い）。

### 6.3 Filtering（§36–§38）
- **One-Euro Filter**: 低速時はノイズ除去を強く、高速時は遅延を最小に。傾き用。
- **Low-pass**: 重力推定用（α=0.08）。
- **水平操作 v2 = 手の移動が主役**（実地テストで傾き主体を廃止）。
  横方向の線形加速度を重力面へ射影し、垂直軸と同じリーク積分＋静止時ゼロ速度更新で
  仮想ポジションへ積算する（`handMotion.ts`）。手を止めればポイもその場に止まる。
  iOSの符号反転は `gravSign` で吸収（水平は縦と違い二重反転が相殺しない）。
- **傾きは補助に降格**: dead zone ±7°（手首の揺れでは絶対に動かない）、
  それ以上傾け続けたときだけ最大 0.5 正規化単位/s で滑る。水槽横断用。
- **水の抵抗**: 水中ではポイの追従が2.2倍重く・最高速度55%に。狙いが安定する。
- **Velocity / Acceleration Threshold** と **Cooldown**: ジェスチャ誤爆防止。

### 6.4 Gestures（§33, §34）— 連続的な高さモデル（v2）
実地テストで v1（急峻な加速度閾値）はゆっくり下げる動きを取りこぼした。
v2 は実物の金魚すくいと同じ **手の高さ・速度そのもの** を一次信号にする。

- **入水**: 推定変位 −5cm 以下、または下向き速度 0.2 m/s 持続、または急な押し込み。
- **水中維持**: 退出判定は速度ベースのみ。リーク積分が変位をゼロへ戻しても
  勝手に水から出ることはない（手を下げたままなら何秒でも水中）。
- **静かな引き上げ**: 上向き速度 0.14 m/s 持続で解放 → サーバー側が低速リフトに変換
  （§55 の「ゆっくりが確実」）。
- **LIFT**: +3.0 m/s² かつ 0.28 m/s 持続 → `liftPeakAccel` を記録し耐久モデルが課金。
  「水中」はサーバーechoまたは自己申告（SUBMERGE後0.35秒）——往復待ちで
  素早いすくいを取りこぼさない。
- **フリックすくい**: 水中で手首をさっと返す（tiltY速度 +2.0 rad/s 持続）も正式なLIFT。
  実物のすくい動作は手首の返しであり、実地テストの「上に傾けてもすくえない」への回答。
  縦加速度ゲートは下向きのみに適用（返しの上向き成分を食わない）。
- リークは速度 1.0s / 変位 1.8s。ゼロ速度更新は「分散が小さい **かつ** 加速度自体が
  ほぼゼロ」のときのみ（等加速度の滑らかな動きを静止と誤認しないため）。
- 回転レートで垂直加速度をゲート（傾け操作の重力推定ラグが偽のすくい上げに
  ならないように）。
- 水上でもポイは `handOffsetY` に追従して上下する（Above 状態のボビング）。

### 6.5 送信（§40）
`requestAnimationFrame` で 60Hz に間引いて `INPUT` パケット送信。
バックグラウンド時は送信停止（=ポイ停止）。

---

## 7. Room Management

`src/network/rooms/RoomManager.ts` / `GameRoom.ts`（server-only）。

- 1 巨大スクリーン = 1 Room（§41）。Room ID は URL 由来（例 `FESTIVAL01`）。
- Room は screen が接続していなくても生成できる（先にスマホが来ても良い）。
- 席割当は接続順に PLAYER 1..4（§45）。空席は再利用。
- `hardMaxPlayers = 8` まで内部的に対応、`settings.maxPlayers` の既定は 4（§11）。
- Room は最後の接続が切れて 5 分後に破棄。

### 状態遷移（§42, §43）

```
WAITING ──(全員 controllerReady && 1人以上 && admin/自動 START)──> CALIBRATION (3.2s)
CALIBRATION ──> COUNTDOWN (3.5s: 3,2,1,START!)
COUNTDOWN ──> PLAYING (settings.durationSeconds)
PLAYING ──(time up)──> RESULT (22s)
RESULT ──> WAITING
```

`GameRoom` は 60Hz の `setInterval`（実測 dt で積分）で tick。

---

## 8. Game State

- `RoomPublicState` を JSON で全員にブロードキャスト（変化時 + 1Hz のハートビート）。
- `PhasePayload` はフェーズ変化時に即時、カウントダウン中は 1 秒毎。
- 各スマホには自分だけの `bowl:state`（スコア・捕獲魚・ポイ状態）を送る。

---

## 9. Fish System

### 9.1 データ
`FISH_CATALOG`（§66）: red 100 / redwhite 200 / black 300 / demekin 500 / gold 1000。
rarity は Common / Rare / SuperRare / Legendary（§68）。

### 9.2 シミュレーション（§70–§73）
`FishSimulation` は SoA（Float32Array）で 200 匹を扱う。

**空間ハッシュ**（セル 1.2 単位）で近傍探索を O(n)。

毎 tick の力の合成:
1. **Boids**（§72）: Separation / Alignment / Cohesion（重み × `schooling`）
2. **Wander**: 個体別位相の value noise
3. **Depth preference**: `depthPreference` へ弱く引く
4. **Wall avoidance**: 壁・床・水面からの反発
5. **Poi fear**（§73）: 各ポイからの距離。`fear` が高いほど検知半径が広く反発が強い。
   水中のポイのみ強く恐れる。レア魚ほど早く逃げる＝捕まえにくい。
6. **Curiosity**: 静止しているポイには `curiosity` に応じて近づく個体もいる。

速度をクランプ → 位置更新 → 向き（yaw/pitch）を `turnSpeed` で追従 → `roll` は旋回に応じたバンク。

**距離ベース更新（§77）**: カメラから遠い個体は Boids を 2 tick に 1 回に間引く。

### 9.3 状態（§75）
`IdleSwim / FastSwim / Escape / Captured / Drop / BowlSwim`。
`Captured` の間はポイに親子付けされ、ポイ座標系で水面から持ち上がる（§80 瞬間移動禁止）。

### 9.4 描画
- 手続き生成の 3D 金魚メッシュ（体・尾・左右のヒレ・背びれ）を **頂点シェーダーで遊泳変形**。
  Sprite は使わない（§130）。
- `InstancedMesh` を魚種ごとに 1 つ。`instanceMatrix` + カスタム instanced attributes
  （位相・速度・色相・sheen）。ドローコールは魚種数（5）＋LOD。
- `public/models/fish/<type>.glb` が存在すればそちらを優先ロードする差し替え口を用意
  （§114 の AI 生成アセットを後から差せる）。

---

## 10. Poi System

### 10.1 構造（§50）
```
Poi ├─ Handle（竹の柄 + プレイヤー色の紐）
    ├─ Frame（輪）
    ├─ Paper（薄い円盤メッシュ・格子状に分割）
    ├─ WetMask（濡れの拡がり）
    ├─ TearMask（破れ穴）
    ├─ CaptureArea（判定用の円柱）
    └─ PlayerMarker（色アクセント）
```
ポイ全体は派手にしない。柄と紐にだけ色（§46）。

### 10.2 運動（サーバー側 `poiSimulation.ts`）
- 水平: `tiltX/tiltY` を **絶対位置マッピング**（±32° で水槽端まで）＋臨界減衰追従。
  ドリフトしないので「スマホを水平に戻す＝中央」が直感的。
- 垂直: ジェスチャ状態機械 + 手の推定変位で `Above / Entering / Submerged / Lifting / Raised`。
- ポイ同士: すり抜けない、しかし強い物理にもしない（§49）。半径 0.66 の
  ソフト分離のみ。相手を壊す手段は無い。
- 傾き: スマホの傾きがそのままポイの傾きになる（§32）。傾け過ぎると魚が滑り落ちる。

### 10.3 濡れと耐久（§51–§56）
```
Wetness: 水中で +0.155/s、空中で −0.055/s
Stage:   Dry → Wet(0.30) → VeryWet(0.62) → Tearing(0.86)

Load = FishWeight × LiftAcceleration × WetnessModifier      (§54)
WetnessModifier = 1 + wetness² × 3.4
持ち上げ中: durability -= Load × 5.6 × dt
水中滞在:   durability -= 1.1 × dt
魚の重み:   durability -= 1.6 × totalWeight × dt
```
→ **ゆっくり持ち上げれば成功しやすい（§55）**。勢いよく振り上げると破れる。

### 10.4 破壊（§56, §57）
`紙が濡れる → 伸びる → 中央に小さな穴 → 穴が広がる → 金魚が落ちる`。
即消滅させない。3 秒後に新しいポイ（§57）。任意で −100pt。永久脱落はしない。

---

## 11. Capture System

サーバー権威（§78, §82）。

```
毎 tick、各ポイについて:
  ポイが Submerged/Lifting かつ 未破壊
  → CaptureArea（半径 0.5, 高さ +0.30）内の Swimming な魚を探す
  → 見つかったら fish.state = OnPoi, fish.carriedBy = playerNumber
     （所有権はまだ発生しない §81）
     ※ 同一 tick で複数ポイが同じ魚を掴んだ場合は
       「その魚に近い方 → 先に接触した方（contactStartedAt）」で決定
  → OnPoi の魚はポイ上の相対座標に吸着し、ポイと一緒に動く

プレイヤーが LIFT:
  poi.state = Lifting、上昇開始
  上昇中に
    - 傾き > 0.72rad → 滑り落ちる (DROP: TILT)
    - LiftAcceleration 過大 → 負荷で durability <= 0 → POI BREAK
    - poi.y >= 0.62（水面上）→ 捕獲確定
  捕獲確定時にサーバーが CaptureSuccessTimestamp を採番し ownerPlayerId を設定
  → ev:capture を全員へ、bowl:state を本人へ
```

同時捕獲は「サーバーが `captureSuccessAt` を見て先着 1 名」（§82）。
魚は水面から出るまで消えない（§80）。捕獲確定後 0.55 秒かけてポイ上でフェードし、
スマホのボウルへ「移った」ように見せる（§92）。

---

## 12. Bowl System

スマホ画面の自分専用ボウル（§86–§93）。

- 2D Canvas（`BowlCanvas.tsx`）。60fps、DPR 上限 2。
- ガラス鉢：楕円の内壁・水面のメニスカス・屈折による下部の拡大・ハイライト。
- **魚はアイコン列ではなく実際に泳ぐ（§89）**：
  各魚は位置・速度・尾の位相を持ち、壁で向きを変え、互いを軽く避ける。
  種類は巨大スクリーンで捕った種類と一致（§90）。金色は光る。
- 魚の描画は巨大スクリーンと同じシルエット（体・尾・ヒレ）を 2.5D で描く。
- **捕獲時（§92）**: 上から魚が落ちてくる → 着水しぶき → 水面の輪 → 泳ぎ始める。
  同時にスコアがカウントアップ。
- **傾き（§93）**: `DeviceOrientation` の gamma で水面を最大 6° 傾け、魚が軽く流される。
  ゲーム操作と混同しないよう非常に控えめ。

---

## 13. Rendering

### 13.1 水（§60, §61）— 「青い半透明 Plane だけ」は禁止
`ShaderMaterial` によるカスタム水面。

- **Gerstner 波 3 波 + FBM リップル** による頂点変位と法線。
- **Screen-space refraction**: 水中シーンを FBO に描き、法線で UV を歪めてサンプル。
- **Reflection**: 提灯・屋台のプローブ反射 + 空の擬似反射。
- **Fresnel**: `pow(1 - dot(N,V), 5)` で視線角による反射率変化。
- **Depth color**: 深度差で浅瀬→深部の色を補間、水中の減衰（Beer-Lambert 近似）。
- **Ripple field**: 512×512 の R16F ping-pong テクスチャで波動方程式を解く。
  ポイの出入り・魚の水面通過・捕獲・ポイ接触で加振（§62）。
- **Caustics**（§63）: 水面法線から焦点強度を計算し床に投影（アニメーション付き）。

### 13.2 ライティング（§64）
- 上部：暖色の屋台照明（3000K 相当）＋提灯のポイントライト（赤・黄、ゆらぎ）。
- 水中：青緑のフィル。コントラストを作る。
- 夜の環境なので露出は低め、ハイライトを効かせる。

### 13.3 ポストプロセス
Bloom（提灯と金色金魚だけが光る程度）＋ Vignette ＋ 弱い色収差。
`settings.highQuality=false` で無効化できる。

### 13.4 最適化（§77）
InstancedMesh / Object pooling / LOD（3 段） / Frustum culling /
距離別更新頻度 / `powerPreference: 'high-performance'` /
DPR 上限 1.5（4K では 1.0） / 影は 1 灯のみ。
GLB を差す場合は Draco + Meshopt + KTX2 対応ローダーを用意。

---

## 14. Development Phases

| Phase | 内容 | 仕様 |
|---|---|---|
| **MVP** | Next.js 基盤 → Socket.IO → Room → スマホ参加 → DeviceOrientation → Calibration → 傾き→ポイ移動 → DeviceMotion → Submerge → Lift → 3D 水槽 → 金魚 → Capture → 10 匹 → Score → Bowl → Result | §121–§123 |
| **2** | 金魚 50 匹 / 5 種 / Boids / 高品質水シェーダー / Ripple / Poi Durability / Wetness / Tear / Audio | §124 |
| **3** | 2–4 人 / 取り合い / Player 識別 / Bowl 高品質化 / 補間・予測 / Result ranking | §125 |
| **4** | 100–200 匹 / レア金魚 / Caustics / Reflection / 水滴 Particle / 夏祭り環境 / Lighting / PostFX / 最適化 | §126 |

MVP の時点から **操作は必ずモーションセンサー**（§120）。マウスはデバッグ用のみ。

---

## 15. Test Plan

### 15.1 自動テスト（vitest）
- `codec`: FISH/POI/INPUT のエンコード→デコード往復、境界値クランプ、破損バッファ耐性。
- `filters`: dead zone / one-euro の単調性・収束、NaN 混入耐性。
- `gestureDetector`: 合成加速度列（静止・微振動・下げ・持ち上げ・激しい振り）で
  SUBMERGE/LIFT の発火と誤爆しないこと、cooldown。
- `boids` / `fishSimulation`: 決定論シード下で 60s 走らせて
  境界外に出ない・NaN が出ない・速度が上限内。
- `durability`: ゆっくり持ち上げ ⇒ 破れない、勢いよく ⇒ 破れる、濡れが効く。
- `captureArbiter`: 2 ポイが同一魚を同時に掴む合成ケースで所有者が 1 人に決まる。
- `scoring`: 順位・同点処理・特別賞。
- `roomLifecycle`: WAITING→…→RESULT→WAITING の遷移、途中参加、切断猶予。

### 15.1b 通し確認（`npm run smoke`）

`scripts/smoke.ts` が実サーバーへSocket.IOで接続し、スクリプト化されたプレイヤーとして
1ラウンドを最後まで実行する。自動開始・キャリブレーション要求・スナップショット配信・
ポイ操作・捕獲・耐久消耗・TIME UP・結果までを、WebGL以外の全層について通しで検証する。
会場では開場前にこれを流す。

### 15.2 手動テスト（会場）
1. **接続**: QR → 参加 → 許可 → PLAYER n 表示、スクリーンに `PLAYER n JOINED`。
2. **追従**: スマホを右へ傾ける → 100ms 以内にポイが右へ。左・前・手前も同様。
3. **沈める**: スマホを下げる → ポイが水中へ、波紋。
4. **すくう**: 魚をポイの上へ → ゆっくり上げる → 水面から出る → スコア加算 →
   **スマホのボウルにその魚が現れて泳ぐ**。
5. **破れ**: わざと勢いよく振り上げる → 穴 → 魚が落ちる → 3 秒 → 新しいポイ。
6. **取り合い**: 2 台で同じ金魚を狙い、先に上げた方だけが得点。
7. **切断**: 1 台を機内モード → 他プレイヤーは止まらない → 復帰で同じ席。
8. **60 秒**: TIME UP → ポイが上がる → RESULT → WAITING。
9. **負荷**: 200 匹 + 4 ポイで巨大スクリーンが 60fps を維持。

### 15.3 端末マトリクス
iOS Safari（許可ダイアログ必須）/ iOS Chrome / Android Chrome /
Android Firefox。`acceleration` が null の端末で重力分離が働くこと。

---

## 付録: 実行

```bash
npm install
npm run build
npm run start:https     # 自己署名証明書つき（iOS のセンサーには HTTPS が必要）
```

巨大スクリーン: `https://<PC の LAN IP>:3000/screen/FESTIVAL01`
参加者: スクリーンに出る QR（`https://<LAN IP>:3000/join/FESTIVAL01`）
運営: `https://<LAN IP>:3000/admin`
