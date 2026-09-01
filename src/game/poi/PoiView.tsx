'use client';

/**
 * The poi as it appears on the giant screen.
 *
 * Spec §46: the silhouette is IDENTICAL for every player. Bamboo hoop, bamboo
 * handle, white washi. Only the cord tied around the grip and the little marker
 * plate carry the player's accent colour — never a garish full-colour poi.
 *
 * Everything below is driven straight from the 'PoiWire' the server broadcasts
 * at 60 Hz. The component allocates nothing per frame and creates no material
 * per render: geometry is cached at module level, the handful of per-player
 * materials live in 'useMemo' and are disposed on unmount.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { POI, TANK } from '@/game/core/constants';
import { TAU, clamp, clamp01, lerp, smoothstep } from '@/game/core/math';
import {
  POI_LAYOUT,
  createPoiCordGeometry,
  createPoiFrameGeometry,
  createPoiHandleGeometry,
  createPoiPaperGeometry,
} from '@/game/poi/poiGeometry';
import { createPoiPaperMaterial, setPoiPaperUniforms } from '@/rendering/materials/poiPaperMaterial';
import type { PoiWire } from '@/network/protocol/codec';

// ---------------------------------------------------------------------------
// Shared, immutable resources
// ---------------------------------------------------------------------------

const DROPLET_COUNT = 14;
const DROPLET_BASE_RADIUS = 0.026;
const GRAVITY = 9.81;

/** Scratch objects — only ever touched synchronously inside a useFrame body. */
const scratchVec = new THREE.Vector3();
const scratchObj = new THREE.Object3D();

let dropletGeometry: THREE.SphereGeometry | null = null;
const getDropletGeometry = (): THREE.SphereGeometry => {
  if (!dropletGeometry) dropletGeometry = new THREE.SphereGeometry(1, 7, 5);
  return dropletGeometry;
};

let markerPlateGeometry: THREE.CircleGeometry | null = null;
const getMarkerPlateGeometry = (): THREE.CircleGeometry => {
  if (!markerPlateGeometry) markerPlateGeometry = new THREE.CircleGeometry(0.088, 24);
  return markerPlateGeometry;
};

let glowGeometry: THREE.CircleGeometry | null = null;
const getGlowGeometry = (): THREE.CircleGeometry => {
  if (!glowGeometry) glowGeometry = new THREE.CircleGeometry(0.30, 24);
  return glowGeometry;
};

let ghostDiscGeometry: THREE.CircleGeometry | null = null;
const getGhostDiscGeometry = (): THREE.CircleGeometry => {
  if (!ghostDiscGeometry) ghostDiscGeometry = new THREE.CircleGeometry(POI.paperRadius, 40);
  return ghostDiscGeometry;
};

/** Soft radial falloff used for the marker glow. Built lazily, browser only. */
let glowTexture: THREE.Texture | null = null;
const getGlowTexture = (): THREE.Texture | null => {
  if (glowTexture) return glowTexture;
  if (typeof document === 'undefined') return null;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.42)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  glowTexture = tex;
  return tex;
};

/** The little numbered plate on the handle: accent disc + white numeral. */
const createMarkerTexture = (label: string, color: string): THREE.Texture | null => {
  if (typeof document === 'undefined') return null;
  const size = 192;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.clearRect(0, 0, size, size);
  const r = size * 0.46;
  ctx.fillStyle = '#f2ece0';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, r * 0.86, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#fffaf0';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const text = label.slice(0, 2);
  ctx.font = `bold ${text.length > 1 ? size * 0.46 : size * 0.62}px "Hiragino Sans", "Yu Gothic", sans-serif`;
  ctx.fillText(text, size / 2, size * 0.54);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
};

// ---------------------------------------------------------------------------
// Droplet bookkeeping
// ---------------------------------------------------------------------------

interface DropletState {
  /** 0 = free, 1 = clinging to the rim, 2 = falling. */
  mode: Uint8Array;
  angle: Float32Array;
  cling: Float32Array;
  clingTotal: Float32Array;
  size: Float32Array;
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  vz: Float32Array;
  cursor: number;
  dripTimer: number;
}

const createDropletState = (): DropletState => ({
  mode: new Uint8Array(DROPLET_COUNT),
  angle: new Float32Array(DROPLET_COUNT),
  cling: new Float32Array(DROPLET_COUNT),
  clingTotal: new Float32Array(DROPLET_COUNT),
  size: new Float32Array(DROPLET_COUNT),
  px: new Float32Array(DROPLET_COUNT),
  py: new Float32Array(DROPLET_COUNT),
  pz: new Float32Array(DROPLET_COUNT),
  vx: new Float32Array(DROPLET_COUNT),
  vy: new Float32Array(DROPLET_COUNT),
  vz: new Float32Array(DROPLET_COUNT),
  cursor: 0,
  dripTimer: 0.4,
});

/** Round-robin: prefer a free slot, otherwise recycle the oldest cling. */
const spawnDroplet = (s: DropletState, wetness: number): void => {
  let slot = -1;
  for (let i = 0; i < DROPLET_COUNT; i++) {
    const idx = (s.cursor + i) % DROPLET_COUNT;
    if (s.mode[idx] === 0) {
      slot = idx;
      break;
    }
  }
  if (slot < 0) {
    slot = s.cursor % DROPLET_COUNT;
  }
  s.cursor = (slot + 1) % DROPLET_COUNT;

  const hold = lerp(0.85, 0.22, wetness) * (0.6 + Math.random() * 0.8);
  s.mode[slot] = 1;
  s.angle[slot] = Math.random() * TAU;
  s.cling[slot] = hold;
  s.clingTotal[slot] = hold;
  s.size[slot] = 0.45 + Math.random() * 0.55;
  s.vx[slot] = 0;
  s.vy[slot] = 0;
  s.vz[slot] = 0;
};

// ---------------------------------------------------------------------------
// PoiView
// ---------------------------------------------------------------------------

export interface PoiViewProps {
  /** The latest decoded poi state for this player. Read every frame. */
  poi: PoiWire;
  /** Player accent colour ('PLAYER_COLORS'). */
  color: string;
  playerNumber: number;
  /** Text on the marker plate. Defaults to the player number. */
  label?: string;
}

export function PoiView({ poi, color, playerNumber, label }: PoiViewProps) {
  // The screen client re-samples the poi buffer far more often than it
  // re-renders, so always read through a ref that tracks the latest props.
  const poiRef = useRef(poi);
  poiRef.current = poi;

  const rootRef = useRef<THREE.Group>(null);
  const dropletsRef = useRef<THREE.InstancedMesh>(null);
  const glowRef = useRef<THREE.Mesh>(null);

  const frameGeo = createPoiFrameGeometry();
  const paperGeo = createPoiPaperGeometry();
  const handleGeo = createPoiHandleGeometry();
  const cordGeo = createPoiCordGeometry();

  const markerLabel = label ?? String(playerNumber);

  const res = useMemo(() => {
    const paper = createPoiPaperMaterial();
    setPoiPaperUniforms(paper, { uAccent: color });

    // Bamboo: warm tan, vertex colours carry the grain baked into the geometry.
    const bamboo = new THREE.MeshPhysicalMaterial({
      color: '#d8b878',
      vertexColors: true,
      roughness: 0.62,
      metalness: 0.0,
      // Kept non-zero so animating it never triggers a shader recompile.
      clearcoat: 0.06,
      clearcoatRoughness: 0.35,
      sheen: 0.25,
      sheenColor: new THREE.Color('#ffe6bb'),
    });
    const handle = new THREE.MeshPhysicalMaterial({
      color: '#cdae72',
      vertexColors: true,
      roughness: 0.68,
      metalness: 0.0,
      clearcoat: 0.06,
      clearcoatRoughness: 0.4,
    });
    const cord = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.85,
      metalness: 0.0,
      emissive: new THREE.Color(color),
      emissiveIntensity: 0.10,
    });

    const markerTex = createMarkerTexture(markerLabel, color);
    const marker = new THREE.MeshStandardMaterial({
      map: markerTex,
      color: '#ffffff',
      roughness: 0.45,
      metalness: 0.0,
      emissive: new THREE.Color(color),
      emissiveIntensity: 0.12,
      transparent: true,
      alphaTest: 0.4,
      side: THREE.DoubleSide,
    });

    const glowTex = getGlowTexture();
    const glow = new THREE.MeshBasicMaterial({
      map: glowTex,
      color: new THREE.Color(color),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const droplet = new THREE.MeshPhysicalMaterial({
      color: '#cfe9f2',
      roughness: 0.06,
      metalness: 0.0,
      transparent: true,
      opacity: 0.72,
      clearcoat: 0.9,
      clearcoatRoughness: 0.05,
      depthWrite: false,
    });

    return { paper, bamboo, handle, cord, marker, markerTex, glow, droplet };
  }, [color, markerLabel]);

  useEffect(() => {
    const r = res;
    return () => {
      r.paper.dispose();
      r.bamboo.dispose();
      r.handle.dispose();
      r.cord.dispose();
      r.marker.dispose();
      r.markerTex?.dispose();
      r.glow.dispose();
      r.droplet.dispose();
    };
  }, [res]);

  const drops = useRef<DropletState>(createDropletState());
  const prev = useRef({ y: POI.hoverY, x: 0, z: 0, init: false });

  useEffect(() => {
    // Droplets live in tank space, so their instance matrices are absolute.
    const mesh = dropletsRef.current;
    if (!mesh) return;
    mesh.frustumCulled = false;
    scratchObj.position.set(0, -1000, 0);
    scratchObj.scale.setScalar(0);
    scratchObj.rotation.set(0, 0, 0);
    scratchObj.updateMatrix();
    for (let i = 0; i < DROPLET_COUNT; i++) mesh.setMatrixAt(i, scratchObj.matrix);
    mesh.instanceMatrix.needsUpdate = true;
    // Re-runs whenever the instanced mesh is rebuilt (its 'args' changed), so a
    // fresh buffer never shows up as 14 unit spheres sitting at the origin.
  }, [res.droplet]);

  useFrame((state, rawDelta) => {
    const root = rootRef.current;
    if (!root) return;
    const p = poiRef.current;
    const dt = Math.min(rawDelta, 1 / 20);
    const t = state.clock.elapsedTime;

    const respawning = p.state === 'Respawning';
    const broken = p.state === 'Broken';
    root.visible = !respawning;

    // ------------------------------------------------------------ transform
    root.position.set(p.x, p.y, p.z);
    // Order XZY == Rx(tiltX) . Rz(tiltZ) . Ry(spin), which is exactly the
    // composition PoiSimulation.paperPoint() uses to place carried fish. If the
    // two disagree, a fish visibly floats off the tilted paper.
    root.rotation.set(p.tiltX, p.spin, p.tiltZ);

    const pr = prev.current;
    if (!pr.init) {
      pr.x = p.x;
      pr.y = p.y;
      pr.z = p.z;
      pr.init = true;
    }
    const invDt = dt > 1e-5 ? 1 / dt : 0;
    const velX = clamp((p.x - pr.x) * invDt, -14, 14);
    const velY = clamp((p.y - pr.y) * invDt, -14, 14);
    const velZ = clamp((p.z - pr.z) * invDt, -14, 14);

    // -------------------------------------------------------- paper uniforms
    // How deeply the paper is under the surface (0 above, 1 well submerged).
    const submersion = smoothstep(0.05, -0.32, p.y);
    // Mechanical load: fish resting on the sheet, plus the lift itself, plus
    // the damage already taken — a nearly dead poi hangs visibly heavier.
    const carried = clamp01(p.carriedFish * 0.34);
    const liftPush = clamp01(Math.max(0, p.vy) * 0.55);
    const worn = clamp01(1 - p.durability / POI.maxDurability);
    const stress = clamp01(carried * (0.62 + 0.55 * liftPush) + worn * 0.28 + liftPush * 0.12);

    setPoiPaperUniforms(res.paper, {
      uWetness: p.wetness,
      uTear: broken ? Math.max(p.tear, 0.55) : p.tear,
      uTime: t,
      uSubmersion: submersion,
      uStress: stress,
    });

    // ----------------------------------------------------------- wet sheen
    // Fades out on its own because 'wetness' decays while the poi is in the air.
    const sheen = clamp01(p.wetness * 1.15);
    res.bamboo.roughness = lerp(0.62, 0.14, sheen);
    res.bamboo.clearcoat = lerp(0.06, 0.85, sheen);
    res.handle.roughness = lerp(0.68, 0.24, sheen * 0.75);
    res.handle.clearcoat = lerp(0.06, 0.55, sheen * 0.75);

    // ------------------------------------------------------------- marker
    const glow = glowRef.current;
    if (glow) {
      // A soft accent pulse while the poi is out of play, so the audience can
      // see whose poi tore and that it is coming back.
      const pulse = broken || respawning ? 0.5 + 0.5 * Math.sin(t * 7.5) : 0;
      res.marker.emissiveIntensity = 0.12 + pulse * 0.95;
      res.glow.opacity = pulse * 0.55;
      glow.visible = pulse > 0.01;
      const s = 1 + pulse * 0.18;
      glow.scale.setScalar(s);
    }

    // ------------------------------------------------------------ droplets
    const mesh = dropletsRef.current;
    if (mesh) {
      const s = drops.current;
      const aboveWater = p.y > 0.03;
      const wasBelow = pr.y <= 0.03;

      if (!respawning && p.wetness > 0.1) {
        // A lift out of the water throws a burst of drops off the rim.
        if (aboveWater && wasBelow) {
          const burst = Math.round(3 + p.wetness * 7);
          for (let i = 0; i < burst; i++) spawnDroplet(s, p.wetness);
          s.dripTimer = 0.12;
        }
        // Then it keeps dripping while it dries out.
        if (aboveWater && p.wetness > 0.22) {
          s.dripTimer -= dt;
          if (s.dripTimer <= 0) {
            spawnDroplet(s, p.wetness);
            s.dripTimer = lerp(0.62, 0.13, p.wetness) * (0.6 + Math.random() * 0.9);
          }
        }
      }

      let dirty = false;
      for (let i = 0; i < DROPLET_COUNT; i++) {
        const mode = s.mode[i];
        if (mode === 0) continue;
        dirty = true;

        if (mode === 1) {
          s.cling[i] -= dt;
          // Ride the rim: recomputed from the poi's current transform so the
          // drop stays glued on while the player waves the phone about.
          const a = s.angle[i];
          const swell = 1 - clamp01(s.cling[i] / Math.max(s.clingTotal[i], 1e-3));
          scratchVec.set(
            Math.cos(a) * POI.frameRadius,
            -POI_LAYOUT.frameHalfHeight - 0.006 - swell * 0.012,
            Math.sin(a) * POI.frameRadius,
          );
          scratchVec.applyEuler(root.rotation).add(root.position);
          s.px[i] = scratchVec.x;
          s.py[i] = scratchVec.y;
          s.pz[i] = scratchVec.z;
          if (s.cling[i] <= 0 || p.y < 0.0) {
            s.mode[i] = 2;
            s.vx[i] = velX * 0.3 + (Math.random() - 0.5) * 0.12;
            s.vy[i] = Math.min(velY * 0.25, 0.4) - 0.05;
            s.vz[i] = velZ * 0.3 + (Math.random() - 0.5) * 0.12;
          }
        } else {
          s.vy[i] -= GRAVITY * dt;
          s.px[i] += s.vx[i] * dt;
          s.py[i] += s.vy[i] * dt;
          s.pz[i] += s.vz[i] * dt;
          if (s.py[i] <= TANK.surfaceY + 0.012) {
            s.mode[i] = 0;
          }
        }

        if (s.mode[i] === 0) {
          scratchObj.position.set(0, -1000, 0);
          scratchObj.scale.setScalar(0);
          scratchObj.rotation.set(0, 0, 0);
        } else {
          const speed = Math.abs(s.vy[i]);
          // Falling drops stretch along their fall, keeping the volume roughly
          // constant so they read as water and not as growing balls.
          const stretch = 1 + clamp(speed * 0.20, 0, 1.7);
          const squash = 1 / Math.sqrt(stretch);
          const r = DROPLET_BASE_RADIUS * (0.55 + s.size[i] * 0.7);
          scratchObj.position.set(s.px[i], s.py[i], s.pz[i]);
          scratchObj.rotation.set(0, 0, 0);
          scratchObj.scale.set(r * squash, r * stretch, r * squash);
        }
        scratchObj.updateMatrix();
        mesh.setMatrixAt(i, scratchObj.matrix);
      }
      if (dirty) mesh.instanceMatrix.needsUpdate = true;
    }

    pr.x = p.x;
    pr.y = p.y;
    pr.z = p.z;
  });

  return (
    <>
      <group ref={rootRef} rotation-order="XZY">
        <mesh geometry={handleGeo} material={res.handle} castShadow receiveShadow />
        <mesh geometry={frameGeo} material={res.bamboo} castShadow receiveShadow />
        <mesh geometry={paperGeo} material={res.paper} castShadow={false} receiveShadow={false} />
        <mesh geometry={cordGeo} material={res.cord} castShadow />

        {/* Player marker — faces up so the overhead camera reads it. */}
        <mesh
          geometry={getMarkerPlateGeometry()}
          material={res.marker}
          position={[0, POI_LAYOUT.handleY + POI.handleRadius * 1.05, POI_LAYOUT.markerZ]}
          rotation={[-Math.PI / 2, 0, 0]}
        />
        <mesh
          ref={glowRef}
          geometry={getGlowGeometry()}
          material={res.glow}
          position={[0, POI_LAYOUT.handleY + POI.handleRadius * 1.2, POI_LAYOUT.markerZ]}
          rotation={[-Math.PI / 2, 0, 0]}
          visible={false}
        />
      </group>

      {/* Droplets are written in the poi's PARENT space — the same space
          `poi.x/y/z` live in. Sibling of the root group, never a child of it:
          once a drop lets go it must not follow the poi around. */}
      <instancedMesh
        ref={dropletsRef}
        args={[getDropletGeometry(), res.droplet, DROPLET_COUNT]}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// PoiGhost
// ---------------------------------------------------------------------------

export interface PoiGhostProps {
  x: number;
  z: number;
  color: string;
}

/**
 * The outline of a poi fading back in while a broken one respawns (spec §57).
 * Purely decorative: it has no simulation state and takes no input.
 */
export function PoiGhost({ x, z, color }: PoiGhostProps) {
  const groupRef = useRef<THREE.Group>(null);

  const res = useMemo(() => {
    const ring = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const disc = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#eaf4ff'),
      transparent: true,
      opacity: 0.1,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    return { ring, disc };
  }, [color]);

  useEffect(() => {
    const r = res;
    return () => {
      r.ring.dispose();
      r.disc.dispose();
    };
  }, [res]);

  useFrame((state) => {
    const g = groupRef.current;
    if (!g) return;
    const t = state.clock.elapsedTime;
    // Breathe in and out, drift a little, and turn slowly: unmistakably "not
    // yet real", but clearly holding the seat for this player.
    const breathe = 0.5 + 0.5 * Math.sin(t * 3.4);
    g.position.set(x, POI.hoverY + 0.06 * Math.sin(t * 1.7), z);
    g.rotation.y = t * 0.55;
    g.scale.setScalar(0.92 + breathe * 0.10);
    res.ring.opacity = 0.20 + breathe * 0.42;
    res.disc.opacity = 0.04 + breathe * 0.11;
  });

  return (
    <group ref={groupRef}>
      <mesh geometry={createPoiFrameGeometry()} material={res.ring} />
      <mesh geometry={getGhostDiscGeometry()} material={res.disc} rotation={[-Math.PI / 2, 0, 0]} />
    </group>
  );
}
