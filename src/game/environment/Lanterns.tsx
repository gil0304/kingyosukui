'use client';

/**
 * 提灯 — the red-and-white paper lanterns strung around the stall (spec §59, §64).
 *
 * Each lantern is a ribbed lathe of glowing paper with its own warm point light,
 * hung from a wire and swinging on a slow, uncorrelated noise. The flicker is a
 * candle, not a strobe: it never drops below ~0.8 of its base level and it moves
 * at roughly 1 Hz, so on a projector it reads as breathing warmth.
 *
 * 'LANTERN_POSITIONS' / 'LANTERN_COLORS' are exported because the water surface
 * needs them to paint the lantern reflections without knowing anything about
 * this component's internals. The positions are the centres of the glowing
 * bodies at rest — the sway is a few centimetres and is deliberately not baked
 * into the exported values.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { TAU, noise1 } from '@/game/core/math';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Height of the paper body, and how far below its wire it hangs. */
const BODY_HEIGHT = 0.72;
const BODY_RADIUS = 0.30;
const CORD_LENGTH = 0.20;
/** Distance from the wire (the pivot) down to the centre of the body. */
const PIVOT_TO_CENTRE = CORD_LENGTH + BODY_HEIGHT / 2;

/** Centres of the glowing bodies, in tank space. Consumed by the water shader. */
export const LANTERN_POSITIONS: readonly (readonly [number, number, number])[] = [
  // Behind the tank, flanking the 金魚すくい sign.
  [-6.2, 2.35, -4.75],
  [-3.5, 2.35, -4.75],
  [3.5, 2.35, -4.75],
  [6.2, 2.35, -4.75],
  // Along the sides of the stall.
  [-7.05, 1.95, -1.4],
  [7.05, 1.95, -1.4],
  // Over the near rim — mostly out of frame, but they light the front rail and
  // throw the strongest reflections onto the water.
  [-5.9, 2.7, 4.6],
  [5.9, 2.7, 4.6],
];

/** Emitted colour of each lantern, in the same order. */
export const LANTERN_COLORS: readonly string[] = [
  '#ff6034',
  '#ffcf8f',
  '#ffcf8f',
  '#ff6034',
  '#ff6034',
  '#ff6034',
  '#ffcf8f',
  '#ffcf8f',
];

/** True where the lantern is a vermilion one rather than a cream one. */
const IS_RED: readonly boolean[] = LANTERN_COLORS.map((c) => c === '#ff6034');

/** Wires the lanterns hang from: [x0, z0] → [x1, z1] at a given height. */
const WIRES: readonly { from: [number, number]; to: [number, number]; y: number }[] = [
  { from: [-9.0, -4.75], to: [9.0, -4.75], y: 2.35 + PIVOT_TO_CENTRE },
  { from: [-9.0, 4.6], to: [9.0, 4.6], y: 2.7 + PIVOT_TO_CENTRE },
  { from: [-7.05, -5.7], to: [-7.05, 5.7], y: 1.95 + PIVOT_TO_CENTRE },
  { from: [7.05, -5.7], to: [7.05, 5.7], y: 1.95 + PIVOT_TO_CENTRE },
];

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * The paper body: a lathe whose profile bulges to 'BODY_RADIUS' at the waist and
 * is scalloped by the bamboo ribs, so the silhouette is unmistakably a 提灯 and
 * not a sphere.
 */
let bodyGeometry: THREE.LatheGeometry | null = null;
const getBodyGeometry = (): THREE.LatheGeometry => {
  if (bodyGeometry) return bodyGeometry;

  const RIBS = 15;
  const STEPS = 96;
  const points: THREE.Vector2[] = [];
  // The profile MUST run bottom -> top: LatheGeometry derives its normals from
  // the profile's direction, and a top-down profile would light the lantern
  // inside-out. It also puts uv.y = 0 at the bottom, which is what the paper
  // texture is drawn for.
  for (let i = 0; i <= STEPS; i++) {
    const t = 1 - i / STEPS; // 1 at the bottom of the sweep, 0 at the top
    const bulge = Math.pow(Math.sin(Math.PI * t), 0.72);
    const rib = 1 + 0.030 * Math.cos(t * RIBS * TAU);
    const r = (0.10 + (BODY_RADIUS - 0.10) * bulge) * rib;
    points.push(new THREE.Vector2(Math.max(r, 0.02), BODY_HEIGHT / 2 - t * BODY_HEIGHT));
  }
  bodyGeometry = new THREE.LatheGeometry(points, 30);
  return bodyGeometry;
};

let capGeometry: THREE.CylinderGeometry | null = null;
const getCapGeometry = (): THREE.CylinderGeometry => {
  if (!capGeometry) capGeometry = new THREE.CylinderGeometry(0.108, 0.108, 0.055, 16);
  return capGeometry;
};

let cordGeometry: THREE.CylinderGeometry | null = null;
const getCordGeometry = (): THREE.CylinderGeometry => {
  if (!cordGeometry) cordGeometry = new THREE.CylinderGeometry(0.012, 0.012, CORD_LENGTH, 6);
  return cordGeometry;
};

let wireGeometry: THREE.CylinderGeometry | null = null;
const getWireGeometry = (): THREE.CylinderGeometry => {
  // Unit length along +Y; each wire scales and orients it.
  if (!wireGeometry) wireGeometry = new THREE.CylinderGeometry(0.014, 0.014, 1, 6);
  return wireGeometry;
};

// ---------------------------------------------------------------------------
// Paper texture
// ---------------------------------------------------------------------------

/**
 * The printed paper. The lathe puts uv.y = 0 at the bottom of the lantern and
 * the default flipY maps canvas row 0 to uv.y = 1, so the canvas is drawn the
 * right way up and the character stands upright on the finished lantern.
 */
const makePaperTexture = (red: boolean): THREE.Texture | null => {
  if (typeof document === 'undefined') return null;
  const W = 512;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  if (!ctx) return null;

  const body = red ? '#e03a22' : '#f7ecd6';
  const band = red ? '#f7ecd6' : '#d43220';
  const ink = red ? '#2a1408' : '#241008';

  ctx.fillStyle = body;
  ctx.fillRect(0, 0, W, H);

  // Paper fibres.
  ctx.globalAlpha = 0.10;
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = Math.random() < 0.5 ? '#ffffff' : '#000000';
    ctx.fillRect(Math.random() * W, Math.random() * H, 1 + Math.random() * 22, 1);
  }
  ctx.globalAlpha = 1;

  // Bands at the shoulders, the way a shop lantern is printed.
  ctx.fillStyle = band;
  ctx.fillRect(0, H * 0.06, W, H * 0.09);
  ctx.fillRect(0, H * 0.85, W, H * 0.09);

  // A single character on one face, in the middle third of the wrap.
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font =
    'bold 128px "Hiragino Mincho ProN", "Yu Mincho", "MS PMincho", "Songti SC", serif';
  ctx.fillText(red ? '祭' : '金', W * 0.5, H * 0.5);

  // Soot and wear near the top where the candle sits.
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, 'rgba(40,20,8,0.30)');
  g.addColorStop(0.25, 'rgba(40,20,8,0.0)');
  g.addColorStop(0.85, 'rgba(40,20,8,0.0)');
  g.addColorStop(1, 'rgba(40,20,8,0.22)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
};

// ---------------------------------------------------------------------------
// One lantern
// ---------------------------------------------------------------------------

interface LanternProps {
  index: number;
  position: readonly [number, number, number];
  color: string;
  paper: THREE.MeshStandardMaterial;
  hardware: THREE.MeshStandardMaterial;
  withLight: boolean;
}

function Lantern({ index, position, color, paper, hardware, withLight }: LanternProps) {
  const pivotRef = useRef<THREE.Group>(null);
  const lightRef = useRef<THREE.PointLight>(null);

  // Each lantern gets its own material so its flicker is independent; the
  // texture and geometry are still shared.
  const material = useMemo(() => {
    const m = paper.clone();
    m.emissive = new THREE.Color(color);
    return m;
  }, [paper, color]);

  useEffect(() => () => material.dispose(), [material]);

  // Uncorrelated phases: two lanterns must never breathe in step.
  const phase = useMemo(() => index * 37.13 + 4.7, [index]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;

    const pivot = pivotRef.current;
    if (pivot) {
      // Pendulum sway around the wire, a couple of degrees, two slow axes.
      pivot.rotation.z = 0.052 * noise1(t * 0.43 + phase);
      pivot.rotation.x = 0.040 * noise1(t * 0.37 + phase + 11.0);
    }

    // Candle: a slow base wander plus a faint fast tremor. Never a strobe.
    const slow = noise1(t * 1.15 + phase);
    const fast = noise1(t * 4.3 + phase * 1.7);
    const glow = 1 + slow * 0.14 + fast * 0.05;

    material.emissiveIntensity = 1.55 * glow;
    const light = lightRef.current;
    if (light) light.intensity = 6.0 * glow;
  });

  return (
    <group position={[position[0], position[1] + PIVOT_TO_CENTRE, position[2]]}>
      <group ref={pivotRef}>
        <mesh geometry={getCordGeometry()} material={hardware} position={[0, -CORD_LENGTH / 2, 0]} />
        <mesh
          geometry={getCapGeometry()}
          material={hardware}
          position={[0, -CORD_LENGTH - 0.02, 0]}
        />
        <mesh geometry={getBodyGeometry()} material={material} position={[0, -PIVOT_TO_CENTRE, 0]} />
        <mesh
          geometry={getCapGeometry()}
          material={hardware}
          position={[0, -CORD_LENGTH - BODY_HEIGHT + 0.02, 0]}
        />
        {withLight && (
          <pointLight
            ref={lightRef}
            color={color}
            intensity={6.0}
            distance={11}
            decay={1.7}
            position={[0, -PIVOT_TO_CENTRE, 0]}
          />
        )}
      </group>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Lanterns
// ---------------------------------------------------------------------------

export interface LanternsProps {
  /**
   * Attach a real point light to each lantern. Leave on: this is where most of
   * the warm-above half of the §64 contrast comes from. Turn it off only if
   * something else in the scene is already supplying lantern lights.
   */
  lights?: boolean;
  /**
   * Light every Nth lantern instead of all of them — the cheap way to cut the
   * per-fragment light count on a weak projector machine.
   */
  lightStride?: number;
}

export function Lanterns({ lights = true, lightStride = 1 }: LanternsProps = {}) {
  const wireRefs = useRef<THREE.Mesh[]>([]);

  const res = useMemo(() => {
    const redTex = makePaperTexture(true);
    const whiteTex = makePaperTexture(false);

    const make = (tex: THREE.Texture | null): THREE.MeshStandardMaterial =>
      new THREE.MeshStandardMaterial({
        map: tex,
        emissiveMap: tex,
        emissive: new THREE.Color('#ff6034'),
        emissiveIntensity: 1.55,
        color: '#ffffff',
        roughness: 0.92,
        metalness: 0.0,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.97,
      });

    const redPaper = make(redTex);
    const whitePaper = make(whiteTex);

    const hardware = new THREE.MeshStandardMaterial({
      color: '#20180f',
      roughness: 0.85,
      metalness: 0.05,
    });

    return { redTex, whiteTex, redPaper, whitePaper, hardware };
  }, []);

  useEffect(() => {
    const r = res;
    return () => {
      r.redTex?.dispose();
      r.whiteTex?.dispose();
      r.redPaper.dispose();
      r.whitePaper.dispose();
      r.hardware.dispose();
    };
  }, [res]);

  // Wires are static; orient each unit cylinder once on mount.
  useEffect(() => {
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3();
    WIRES.forEach((w, i) => {
      const mesh = wireRefs.current[i];
      if (!mesh) return;
      dir.set(w.to[0] - w.from[0], 0, w.to[1] - w.from[1]);
      const len = dir.length();
      mesh.position.set(
        (w.from[0] + w.to[0]) / 2,
        w.y,
        (w.from[1] + w.to[1]) / 2,
      );
      mesh.quaternion.setFromUnitVectors(up, dir.normalize());
      mesh.scale.set(1, len, 1);
      // A real wire sags; a straight one reads as a pipe. A gentle droop is
      // enough at this distance.
      mesh.position.y -= 0.04;
    });
  }, []);

  const stride = Math.max(1, Math.round(lightStride));

  return (
    <group name="lanterns">
      {WIRES.map((w, i) => (
        <mesh
          key={`wire-${i}`}
          ref={(m: THREE.Mesh | null) => {
            if (m) wireRefs.current[i] = m;
          }}
          geometry={getWireGeometry()}
          material={res.hardware}
        />
      ))}

      {LANTERN_POSITIONS.map((p, i) => (
        <Lantern
          key={`lantern-${i}`}
          index={i}
          position={p}
          color={LANTERN_COLORS[i]}
          paper={IS_RED[i] ? res.redPaper : res.whitePaper}
          hardware={res.hardware}
          withLight={lights && i % stride === 0}
        />
      ))}
    </group>
  );
}
