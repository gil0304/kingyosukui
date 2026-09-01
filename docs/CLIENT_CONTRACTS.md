# CLIENT CONTRACTS — what the page layer may use

Read together with `docs/MODULE_CONTRACTS.md`. Everything below is **already implemented
and typechecks**. Use it exactly as written; do not modify any of these files.

> **Do not put a backtick character inside any comment.** Several modules embed GLSL in
> template literals and a stray backtick terminates the string. Use plain quotes.

## Networking (implemented)

```ts
import { useScreenSocket } from '@/network/socket/useScreenSocket';
//  -> { room, phase, connected, fishBuffer, poiBuffer,
//       onCapture, onDrop, onBreak, onRespawn, onSplash, onJoined, onLeft, onRare, onResult }
//  every on*() returns an unsubscribe function and does NOT re-render.

import { useControllerSocket } from '@/network/socket/useControllerSocket';
//  -> { connected, joinPhase, error, playerId, playerNumber, color, spectating,
//       room, phase, bowl, result, status, latencyMs, calibrating,
//       join(), leave(), onCapture, onBreak, adapter }
//  join() MUST be called directly from a click handler (iOS permission rule).

import { useAdminSocket } from '@/network/socket/useAdminSocket';
//  -> { connected, room, send(cmd: AdminCommand) }

import { FishSnapshotBuffer, PoiStateBuffer } from '@/network/state/snapshotBuffer';
//  fishBuffer.sample(seconds) -> FishSnapshot[]   (interpolated, reused array)
//  poiBuffer.sample(seconds, dt) -> PoiWire[]     (lightly smoothed, reused array)
```

`RoomPublicState`, `PhasePayload`, `CapturePayload`, `GameResult`, `BowlStatePayload`,
`AdminCommand` etc. come from `@/types` and `@/network/protocol/events`.

## Scene components (implemented)

```tsx
import { WaterSurface, useRippleField } from '@/game/water/WaterSurface';
//  const ripple = useRippleField();            // inside <Canvas> only
//  <WaterSurface rippleField={ripple} quality={settings.highQuality} renderScene={!postFx} />
//  IMPORTANT: WaterSurface uses useFrame(priority 1) and therefore OWNS the render loop.
//  If <Effects> is mounted, pass renderScene={false} so the composer does the final draw.
//  ripple.addRipple(worldX, worldZ, strength, radius)   // radius is REQUIRED

import { Caustics } from '@/game/water/Caustics';       // <Caustics rippleTexture={ripple.texture} quality={...} />
import { Underwater } from '@/game/water/Underwater';   // <Underwater />
import { FestivalStall } from '@/game/environment/FestivalStall';
import { Lanterns } from '@/game/environment/Lanterns';           // <Lanterns lights lightStride={1} />
import { FestivalLighting } from '@/game/environment/Lighting';   // quality: 'low'|'medium'|'high'
import { FishSchool } from '@/game/fish/FishSchool';              // <FishSchool fish={snapshots} quality="high" />
import { PoiView, PoiGhost } from '@/game/poi/PoiView';           // <PoiView poi={poiWire} color={hex} playerNumber={n} label="P2" />
import { Bubbles } from '@/rendering/particles/Bubbles';
import { SplashSystem, type SplashHandle } from '@/rendering/particles/SplashSystem';
//  ref.current.spawn(x, y, z, strength01, 'enter'|'exit'|'capture'|'break'|'fish'|'collide')
import { Droplets, type DropletHandle } from '@/rendering/particles/Droplets';
//  ref.current.spawn(x, y, z, count, spread)
import { Effects } from '@/rendering/postprocessing/Effects';     // <Effects enabled quality="high" />
```

## Phone components (implemented)

```tsx
import { BowlCanvas } from '@/smartphone/bowl/BowlCanvas';   // { capturedFish, tilt, className, style }
import { StatusBar } from '@/smartphone/status/StatusBar';   // { playerNumber, color, score, fishCount, connected, latencyMs, timeRemaining }
import { PoiStatus } from '@/smartphone/status/PoiStatus';   // { durability, wetness, state, respawnIn }
import { PhoneResult } from '@/smartphone/result/PhoneResult'; // { playerNumber, color, score, fishCount, capturedFish, rank }
```

## Audio (implemented)

```ts
import { audio } from '@/audio/AudioEngine';
audio.resume();                       // call once from a user gesture / screen click
audio.play('capture', { volume: 0.9, pan: 0.3 });
audio.engine.startAmbience();
audio.engine.setEnabled(bool);
// SfxName: poiEnter poiExit splashSmall splashBig capture captureRare poiTear poiBreak
//          poiRespawn countdown start timeUp drop join resultFanfare bowlDrop
```

## Data helpers

```ts
import { FISH_CATALOG, getFishData, isRare, RARITY_LABEL } from '@/game/fish/fishTypes';
import { formatScore, bestFishOf } from '@/game/scoring/scoring';
import { TANK, POI, GAME, PLAYER_COLORS, CAPTURE, NET } from '@/game/core/constants';
import { clamp, damp, lerp, nowSeconds } from '@/game/core/math';
```

## World / camera

Tank is `TANK.width` (15) x `TANK.depth` (8.6), water surface at y = 0, floor at
y = -2.5. Use camera `position=[0, 4.35, 9.15]`, `fov={42}`, looking at `[0, -0.55, 0]`.
The tank must occupy 85-90% of the screen (spec §99) — HUD hugs the edges only.
