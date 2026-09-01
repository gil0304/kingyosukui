'use client';

/**
 * The school of goldfish on the big screen (spec §65, §76, §77, §130).
 *
 * One 'InstancedMesh' per (species × LOD) — 5 × 3 = 15 meshes, all allocated up
 * front at 'GAME.maxFishCount', so 200 fish cost 15 draw calls and zero
 * allocations per frame. Every fish is a real 3D mesh whose body, tail, both
 * pectoral fins and dorsal fin are deformed in the vertex shader; nothing here
 * is a sprite.
 *
 * This component is pure presentation. It receives snapshots that
 * 'FishSnapshotBuffer' has already interpolated, does no networking, runs no
 * AI, and never decides whether a fish was caught — the server owns all of
 * that (spec §82).
 *
 * Orientation convention: the geometry points +X forward and +Y up, and a
 * snapshot's heading is applied as R = Ry(yaw) · Rz(pitch) · Rx(roll), i.e.
 * forward = (cos yaw, 0, -sin yaw) at pitch 0.
 */

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import {
  BufferGeometry,
  DynamicDrawUsage,
  Euler,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';

import { GAME, POI_BOUNDS, TANK } from '@/game/core/constants';
import { clamp } from '@/game/core/math';
import { animAmplitudeFor, animSpeedFor } from '@/game/fish/fishAnimation';
import {
  FISH_LOD_DISTANCES,
  createFishGeometry,
  type FishLod,
} from '@/game/fish/fishGeometry';
import { FISH_CATALOG } from '@/game/fish/fishTypes';
import { createFishMaterial, updateFishTime } from '@/rendering/materials/fishMaterial';
import { FISH_TYPE_ORDER, fishAnimIndex, fishTypeIndex, type FishSnapshot } from '@/types';

export type FishQuality = 'low' | 'high';

export interface FishSchoolProps {
  /** Already-interpolated snapshots for this frame. */
  fish: readonly FishSnapshot[];
  /**
   * Low quality (the string "low", or the boolean false) drops LOD 0 entirely
   * and pulls the LOD cuts in, which halves the fin tessellation across the
   * whole school (spec §77). Defaults to high.
   */
  quality?: FishQuality | boolean;
}

const LODS: readonly FishLod[] = [0, 1, 2];
const CAPACITY = GAME.maxFishCount;

/**
 * A fish outside this box is not drawn. It is deliberately generous upward:
 * a scooped fish rides the poi to 'POI_BOUNDS.maxY', well clear of the water,
 * and must never pop out of existence on the way (spec §80).
 */
const RENDER_BOUNDS = {
  minX: -TANK.halfWidth - 0.9,
  maxX: TANK.halfWidth + 0.9,
  minZ: -TANK.halfDepth - 0.9,
  maxZ: TANK.halfDepth + 0.9,
  minY: TANK.floorY - 0.6,
  maxY: POI_BOUNDS.maxY + 1.0,
} as const;

/** Deterministic per-fish randomness: the same fish always looks the same. */
const hash01 = (n: number, salt: number): number => {
  let h = Math.imul(n ^ salt, 0x27d4eb2d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x165667b1);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
};

// Reused every frame — the whole point of an InstancedMesh is to allocate nothing.
const _matrix = new Matrix4();
const _quat = new Quaternion();
const _euler = new Euler();
const HALF_PI = Math.PI / 2;
const _pos = new Vector3();
const _scale = new Vector3();

/** An instanced attribute plus a direct handle on its backing store. */
interface Attr {
  attr: InstancedBufferAttribute;
  data: Float32Array;
}

interface Bucket {
  mesh: InstancedMesh;
  geometry: BufferGeometry;
  material: MeshStandardMaterial;
  phase: Attr;
  speed: Attr;
  state: Attr;
  turn: Attr;
  tint: Attr;
  sheen: Attr;
  /** Instances written last frame, so an emptied bucket is flushed exactly once. */
  lastCount: number;
}

const makeAttribute = (itemSize: number): Attr => {
  const data = new Float32Array(CAPACITY * itemSize);
  const attr = new InstancedBufferAttribute(data, itemSize);
  attr.setUsage(DynamicDrawUsage);
  return { attr, data };
};

const buildBuckets = (): Bucket[] => {
  const buckets: Bucket[] = [];
  for (const type of FISH_TYPE_ORDER) {
    for (const lod of LODS) {
      // Clone so the shared cached geometry never receives instanced
      // attributes — another consumer may be drawing it non-instanced.
      const geometry = createFishGeometry(type, lod).clone();
      const material = createFishMaterial(type, lod);

      const phase = makeAttribute(1);
      const speed = makeAttribute(2);
      const state = makeAttribute(1);
      const turn = makeAttribute(1);
      const tint = makeAttribute(3);
      const sheen = makeAttribute(1);

      geometry.setAttribute('aPhase', phase.attr);
      geometry.setAttribute('aSpeed', speed.attr);
      geometry.setAttribute('aState', state.attr);
      geometry.setAttribute('aTurn', turn.attr);
      geometry.setAttribute('aTint', tint.attr);
      geometry.setAttribute('aSheen', sheen.attr);

      const mesh = new InstancedMesh(geometry, material, CAPACITY);
      mesh.name = `fish.${type}.lod${lod}`;
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      // Instances span the entire tank, so the mesh bounds are meaningless;
      // out-of-tank fish are skipped per instance in the frame loop instead.
      mesh.frustumCulled = false;
      // Only the near band casts shadows — 200 shadow-casting fish is not worth
      // the second depth pass (spec §77).
      mesh.castShadow = lod === 0;
      mesh.receiveShadow = false;

      buckets.push({
        mesh,
        geometry,
        material,
        phase,
        speed,
        state,
        turn,
        tint,
        sheen,
        lastCount: 0,
      });
    }
  }
  return buckets;
};

/** Upload only the slice actually used this frame, not the whole 200-slot buffer. */
const flush = (attr: InstancedBufferAttribute, count: number): void => {
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, count * attr.itemSize);
  attr.needsUpdate = true;
};

export function FishSchool({ fish, quality = 'high' }: FishSchoolProps) {
  const buckets = useMemo(buildBuckets, []);
  const counts = useMemo(() => new Int32Array(buckets.length), [buckets]);

  useEffect(
    () => () => {
      for (const b of buckets) {
        b.mesh.dispose();
        b.geometry.dispose();
        b.material.dispose();
      }
    },
    [buckets],
  );

  const low = quality === 'low' || quality === false;

  useFrame((rootState) => {
    updateFishTime(rootState.clock.elapsedTime);

    const cam = rootState.camera.position;
    // Low quality pulls the cuts in so more of the tank falls to LOD 2.
    const lodScale = low ? 0.7 : 1;
    const near = FISH_LOD_DISTANCES[0] * lodScale;
    const far = FISH_LOD_DISTANCES[1] * lodScale;

    counts.fill(0);

    for (let n = 0; n < fish.length; n++) {
      const f = fish[n];
      const held = f.state === 'Captured' || f.state === 'Drop';

      // A fish being scooped is always drawn: its transform comes from the
      // server and follows the poi out of the water (spec §80).
      if (
        !held &&
        (f.x < RENDER_BOUNDS.minX ||
          f.x > RENDER_BOUNDS.maxX ||
          f.z < RENDER_BOUNDS.minZ ||
          f.z > RENDER_BOUNDS.maxZ ||
          f.y < RENDER_BOUNDS.minY ||
          f.y > RENDER_BOUNDS.maxY)
      ) {
        continue;
      }

      const dx = f.x - cam.x;
      const dy = f.y - cam.y;
      const dz = f.z - cam.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      let lod: FishLod = dist < near ? 0 : dist < far ? 1 : 2;
      if (low && lod === 0) lod = 1;

      const bucketIndex = fishTypeIndex(f.type) * 3 + lod;
      const bucket = buckets[bucketIndex];
      const i = counts[bucketIndex];
      if (i >= CAPACITY) continue;
      counts[bucketIndex] = i + 1;

      // --- transform -------------------------------------------------------
      // The species size is already baked into the geometry; only a per-fish
      // size jitter is applied here so no two 赤金魚 are the same fish.
      const sizeJitter = 0.88 + 0.24 * hash01(f.id, 7);
      _pos.set(f.x, f.y, f.z);
      // Frame mismatch, resolved here on purpose.
      //
      //   fishGeometry  -> +X forward, +Y up, +Z the fish's left flank
      //   fishSimulation -> yaw = atan2(vx, vz), i.e. a +Z-FORWARD convention,
      //                     and pitch is negative when the fish is rising.
      //
      // Rotating the geometry to match would break the vertex animation, which
      // sweeps along local X and displaces along local Z. So the heading is
      // converted instead: Ry(yaw - PI/2) takes +X onto (sin yaw, 0, cos yaw),
      // which is exactly the simulation's forward vector, and the pitch is
      // negated because a Z-Euler on a +X-forward body raises the nose for a
      // POSITIVE angle. Roll needs no change: it is the body axis in both
      // frames and leans the same way into a turn.
      _euler.set(f.roll, f.yaw - HALF_PI, -f.pitch, 'YZX');
      _quat.setFromEuler(_euler);
      _scale.setScalar(sizeJitter);
      _matrix.compose(_pos, _quat, _scale);
      bucket.mesh.setMatrixAt(i, _matrix);

      // --- instanced animation / shading attributes ------------------------
      bucket.phase.data[i] = hash01(f.id, 1);
      bucket.speed.data[i * 2] = animSpeedFor(f.state, f.speed01);
      bucket.speed.data[i * 2 + 1] = animAmplitudeFor(f.state, f.speed01);
      bucket.state.data[i] = fishAnimIndex(f.state);
      // Roll is the bank the simulation applies while turning, so it doubles as
      // the turn signal that arches the body.
      bucket.turn.data[i] = clamp(f.roll / 0.55, -1, 1);

      const t = i * 3;
      bucket.tint.data[t] = hash01(f.id, 11);
      bucket.tint.data[t + 1] = hash01(f.id, 13);
      bucket.tint.data[t + 2] = hash01(f.id, 17);
      bucket.sheen.data[i] = FISH_CATALOG[f.type].sheen * (0.85 + 0.3 * hash01(f.id, 19));
    }

    for (let b = 0; b < buckets.length; b++) {
      const bucket = buckets[b];
      const count = counts[b];
      bucket.mesh.count = count;
      if (count === 0 && bucket.lastCount === 0) continue;
      bucket.lastCount = count;
      if (count === 0) continue;

      flush(bucket.mesh.instanceMatrix, count);
      flush(bucket.phase.attr, count);
      flush(bucket.speed.attr, count);
      flush(bucket.state.attr, count);
      flush(bucket.turn.attr, count);
      flush(bucket.tint.attr, count);
      flush(bucket.sheen.attr, count);
    }
  });

  return (
    <group name="fish-school">
      {buckets.map((b) => (
        <primitive key={b.mesh.name} object={b.mesh} />
      ))}
    </group>
  );
}

export default FishSchool;
