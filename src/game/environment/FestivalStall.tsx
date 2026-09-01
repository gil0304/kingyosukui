'use client';

/**
 * The 金魚すくい stall around the tank (spec §58, §59, §64).
 *
 * This is what stops the screen looking like a physics demo: a heavy wooden
 * tub with visible grain, the 紅白幕 skirt hanging off the rim and breathing in
 * the night air, the stall's timber posts and roof beams, a hand-painted
 * wooden 「金魚すくい」 sign, and a dark summer-night backdrop so the lit water
 * is the brightest thing on the projector.
 *
 * Everything here is procedural — geometry built in code, textures painted into
 * offscreen canvases. No asset files, no font files, nothing to ship to the
 * venue but the source.
 */

import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { TANK } from '@/game/core/constants';
import { TAU } from '@/game/core/math';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Thickness of the wooden wall of the tub. */
const RIM_T = 0.42;
/** Top of the rim (above the water line) and bottom of the tub. */
const RIM_TOP = TANK.rimHeight;
const TUB_BOTTOM = TANK.floorY - 0.14;
const TUB_H = RIM_TOP - TUB_BOTTOM;
const TUB_CY = (RIM_TOP + TUB_BOTTOM) / 2;

const OUT_W = TANK.halfWidth + RIM_T;
const OUT_D = TANK.halfDepth + RIM_T;

/** Where the 紅白幕 hangs from, and how far down it reaches. */
const SKIRT_TOP = RIM_TOP - 0.30;
const SKIRT_H = 2.35;

/** Stall frame. Kept low enough to stay inside a 42° fov from (0, 3.2, 9.6). */
const POST_X = 8.75;
const POST_Z_BACK = -5.7;
const POST_Z_FRONT = 5.7;
const POST_TOP = 3.55;
const BEAM_Y = 3.18;

const GROUND_Y = TUB_BOTTOM - 0.05;

// ---------------------------------------------------------------------------
// Canvas textures
// ---------------------------------------------------------------------------

const canvas2d = (w: number, h: number): CanvasRenderingContext2D | null => {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c.getContext('2d');
};

/** A 1×1 stand-in so SSR (or a context-less canvas) never crashes the scene. */
const fallbackTexture = (): THREE.Texture => {
  const t = new THREE.DataTexture(new Uint8Array([180, 140, 96, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
};

/**
 * Painted wood: a base tone, long wandering grain lines, a couple of knots the
 * grain flows around, and a fine speckle so it never looks like flat vinyl.
 */
const makeWoodTexture = (
  size: number,
  base: string,
  dark: string,
  light: string,
  knots: number,
): THREE.Texture => {
  const ctx = canvas2d(size, size);
  if (!ctx) return fallbackTexture();

  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  // Grain runs along +X.
  const lines = Math.round(size * 0.5);
  for (let i = 0; i < lines; i++) {
    const y0 = Math.random() * size;
    const amp = 2 + Math.random() * 7;
    const freq = 0.004 + Math.random() * 0.012;
    const phase = Math.random() * TAU;
    ctx.strokeStyle = Math.random() < 0.62 ? dark : light;
    ctx.globalAlpha = 0.05 + Math.random() * 0.16;
    ctx.lineWidth = 0.6 + Math.random() * 2.4;
    ctx.beginPath();
    for (let x = 0; x <= size; x += 6) {
      const y = y0 + Math.sin(x * freq + phase) * amp;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  for (let k = 0; k < knots; k++) {
    const kx = Math.random() * size;
    const ky = Math.random() * size;
    const kr = size * (0.012 + Math.random() * 0.022);
    for (let r = 6; r > 0; r--) {
      ctx.strokeStyle = r % 2 === 0 ? dark : light;
      ctx.globalAlpha = 0.10 + (6 - r) * 0.05;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.ellipse(kx, ky, kr * r * 0.55, kr * r * 0.24, Math.random() * 0.6, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.ellipse(kx, ky, kr * 0.4, kr * 0.18, 0, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 16;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(ctx.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
};

/**
 * The 「金魚すくい」 sign: a weathered plank with a red border and thick brush
 * lettering. The font stack is generic (Mincho → any serif) so no font file has
 * to be installed on the venue machine.
 */
const makeSignTexture = (): THREE.Texture => {
  const W = 1536;
  const H = 384;
  const ctx = canvas2d(W, H);
  if (!ctx) return fallbackTexture();

  // Plank.
  ctx.fillStyle = '#c8a06a';
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 420; i++) {
    const y0 = Math.random() * H;
    ctx.strokeStyle = Math.random() < 0.6 ? '#8a643a' : '#e0bf90';
    ctx.globalAlpha = 0.05 + Math.random() * 0.14;
    ctx.lineWidth = 0.7 + Math.random() * 2.6;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 12) {
      ctx.lineTo(x, y0 + Math.sin(x * 0.006 + y0) * 4);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Board seams so it reads as planks nailed together.
  ctx.strokeStyle = 'rgba(70,45,24,0.35)';
  ctx.lineWidth = 3;
  for (const y of [H * 0.33, H * 0.67]) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  // Vermilion border.
  ctx.strokeStyle = '#b8332a';
  ctx.lineWidth = 14;
  ctx.strokeRect(20, 20, W - 40, H - 40);
  ctx.strokeStyle = 'rgba(60,25,20,0.35)';
  ctx.lineWidth = 3;
  ctx.strokeRect(34, 34, W - 68, H - 68);

  // Lettering — drawn three times with tiny offsets for a brushed, inky edge.
  const text = '金魚すくい';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font =
    'bold 210px "Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "MS PMincho", "Songti SC", serif';
  const cx = W / 2;
  const cy = H / 2 + 8;

  ctx.fillStyle = 'rgba(30,18,10,0.30)';
  ctx.fillText(text, cx + 5, cy + 6);
  ctx.fillStyle = 'rgba(24,16,12,0.55)';
  ctx.fillText(text, cx - 2, cy - 2);
  ctx.fillStyle = '#1a120c';
  ctx.fillText(text, cx, cy);

  // Wear: scrape a little ink back off.
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 260; i++) {
    ctx.globalAlpha = 0.05 + Math.random() * 0.20;
    ctx.beginPath();
    ctx.ellipse(
      Math.random() * W,
      Math.random() * H,
      2 + Math.random() * 14,
      1 + Math.random() * 4,
      Math.random() * Math.PI,
      0,
      TAU,
    );
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(ctx.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
};

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Box with world-scaled UVs, so the grain density is the same on every timber. */
const timberCache = new Map<string, THREE.BoxGeometry>();
const timber = (w: number, h: number, d: number): THREE.BoxGeometry => {
  const key = `${w.toFixed(3)}|${h.toFixed(3)}|${d.toFixed(3)}`;
  const hit = timberCache.get(key);
  if (hit) return hit;

  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  // BoxGeometry emits 0..1 per face; rescale so one texture tile ≈ 1.1 units.
  const s = ((w + h + d) / 3) / 1.1;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * s, uv.getY(i) * s);
  }
  uv.needsUpdate = true;
  timberCache.set(key, g);
  return g;
};

interface PerimeterPoint {
  x: number;
  z: number;
  nx: number;
  nz: number;
  s: number;
}

/**
 * Rounded-rectangle perimeter around the tub, sampled at a roughly constant
 * arc-length step so the cloth's stripes stay even all the way round.
 */
const buildPerimeter = (halfW: number, halfD: number, corner: number, step: number): PerimeterPoint[] => {
  const pts: PerimeterPoint[] = [];
  let s = 0;
  let last: { x: number; z: number } | null = null;

  const push = (x: number, z: number, nx: number, nz: number): void => {
    if (last) s += Math.hypot(x - last.x, z - last.z);
    last = { x, z };
    pts.push({ x, z, nx, nz, s });
  };

  const straight = (
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    nx: number,
    nz: number,
    skipFirst: boolean,
  ): void => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.round(len / step));
    for (let i = skipFirst ? 1 : 0; i <= n; i++) {
      const t = i / n;
      push(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, nx, nz);
    }
  };

  const arc = (cx: number, cz: number, a0: number, a1: number): void => {
    const n = Math.max(2, Math.round((Math.abs(a1 - a0) * corner) / step));
    for (let i = 1; i <= n; i++) {
      const a = a0 + (a1 - a0) * (i / n);
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      push(cx + nx * corner, cz + nz * corner, nx, nz);
    }
  };

  const ix = halfW - corner;
  const iz = halfD - corner;

  straight(halfW, -iz, halfW, iz, 1, 0, false);
  arc(ix, iz, 0, Math.PI / 2);
  straight(ix, halfD, -ix, halfD, 0, 1, true);
  arc(-ix, iz, Math.PI / 2, Math.PI);
  straight(-halfW, iz, -halfW, -iz, -1, 0, true);
  arc(-ix, -iz, Math.PI, Math.PI * 1.5);
  straight(-ix, -halfD, ix, -halfD, 0, -1, true);
  arc(ix, -iz, Math.PI * 1.5, TAU);

  return pts;
};

/** A closed loop of cloth hanging from the rim, UV-mapped by arc length. */
const buildSkirtGeometry = (
  pts: PerimeterPoint[],
  topY: number,
  height: number,
  rows: number,
): { geometry: THREE.BufferGeometry; perimeter: number } => {
  const cols = pts.length;
  const total = pts[cols - 1].s + Math.hypot(pts[0].x - pts[cols - 1].x, pts[0].z - pts[cols - 1].z);

  // Duplicate the first column at the end so the UV seam is clean.
  const stride = cols + 1;
  const vertexCount = stride * (rows + 1);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint32Array(cols * rows * 6);

  let v = 0;
  for (let r = 0; r <= rows; r++) {
    const t = r / rows;
    const y = topY - t * height;
    for (let c = 0; c <= cols; c++) {
      const p = pts[c % cols];
      const s = c === cols ? total : p.s;
      const o3 = v * 3;
      positions[o3 + 0] = p.x;
      positions[o3 + 1] = y;
      positions[o3 + 2] = p.z;
      normals[o3 + 0] = p.nx;
      normals[o3 + 1] = 0;
      normals[o3 + 2] = p.nz;
      uvs[v * 2 + 0] = s / total;
      uvs[v * 2 + 1] = t;
      v++;
    }
  }

  let k = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * stride + c;
      const b = a + stride;
      indices[k++] = a;
      indices[k++] = b;
      indices[k++] = a + 1;
      indices[k++] = b;
      indices[k++] = b + 1;
      indices[k++] = a + 1;
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  g.computeBoundingSphere();
  return { geometry: g, perimeter: total };
};

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

/**
 * Wet-wood tint below the water line. Patched into a standard material so the
 * submerged part of the tub darkens and turns green the way soaked timber does,
 * without needing a second material or a second draw call.
 */
const applySubmergedTint = (m: THREE.MeshStandardMaterial): void => {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vTankY;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\n\tvTankY = ( modelMatrix * vec4( transformed, 1.0 ) ).y;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vTankY;')
      // Hooked right after the lit colour is written and BEFORE tone mapping,
      // so the tint happens in linear space like every other light in the scene.
      .replace(
        '#include <opaque_fragment>',
        [
          '#include <opaque_fragment>',
          'float subm = smoothstep( 0.03, -0.85, vTankY );',
          'gl_FragColor.rgb = mix( gl_FragColor.rgb, gl_FragColor.rgb * vec3( 0.26, 0.50, 0.55 ), subm * 0.88 );',
        ].join('\n\t'),
      );
  };
  // Keeps every tub material on one compiled program.
  m.customProgramCacheKey = () => 'kingyo.submergedTint';
};

const CLOTH_VERTEX = /* glsl */ `
uniform float uTime;

varying vec2 vUv;
varying vec3 vNormalW;

// The stall group is never rotated, so object space is world space here.
void main() {
  vUv = uv;

  // The hem is free, the top is nailed to the rim: amplitude grows downward.
  float hang = uv.y;
  float amp = hang * hang * 0.115;

  float a = uv.x * 44.0 + uTime * 1.05;
  float b = uv.x * 15.0 - uTime * 0.71 + hang * 2.6;
  float wave = sin(a) * 0.42 + sin(b) * 0.58;

  vec3 pos = position + normal * wave * amp;
  // Folds shorten the cloth very slightly, so the hem breathes vertically too.
  pos.y -= hang * 0.030 * abs(sin(b));

  // Tilt the normal by the slope of the wave so the folds actually shade.
  float dWave = (cos(a) * 0.42 * 44.0 + cos(b) * 0.58 * 15.0) * amp;
  vec3 tangent = normalize(vec3(-normal.z, 0.0, normal.x));
  vNormalW = normalize(normalize(normal) - tangent * dWave * 0.09 + vec3(0.0, hang * 0.10, 0.0));

  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;

const CLOTH_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uStripes;
uniform vec3  uRed;
uniform vec3  uWhite;
uniform vec3  uWarm;
uniform vec3  uCool;
uniform vec3  uLightDir;

varying vec2 vUv;
varying vec3 vNormalW;

float hash21(vec2 p) {
  p = fract(p * vec2(127.117, 311.743));
  p += dot(p, p + 41.317);
  return fract(p.x * p.y);
}

void main() {
  // Scalloped hem — a stall valance is never cut square.
  float hem = 0.935 + 0.050 * sin(vUv.x * uStripes * 3.14159265);
  if (vUv.y > hem) discard;

  // 紅白: hard vertical stripes, antialiased against the projector's pixels.
  float u = vUv.x * uStripes;
  float f = fract(u);
  float aa = max(fwidth(u), 0.0008) * 0.9;
  float s = smoothstep(0.5 - aa, 0.5 + aa, f);
  vec3 col = mix(uRed, uWhite, s);

  // Woven cotton: fine cross-hatch plus a slubby thread here and there.
  float weave = hash21(floor(vec2(vUv.x * uStripes * 26.0, vUv.y * 220.0)));
  col *= 0.93 + weave * 0.14;

  vec3 N = normalize(vNormalW);
  if (!gl_FrontFacing) N = -N;
  float ndl = max(dot(N, normalize(uLightDir)), 0.0);
  // Cloth is not glossy; a wrapped term keeps the folds soft.
  vec3 lit = col * (uWarm * (0.30 + 0.70 * ndl) + uCool * 0.22);

  // Light falls off toward the hem, and the very bottom picks up the ground.
  lit *= mix(1.06, 0.34, vUv.y);
  lit += uRed * 0.03 * smoothstep(0.6, 1.0, vUv.y);

  gl_FragColor = vec4(lit, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const NIGHT_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const NIGHT_FRAGMENT = /* glsl */ `
varying vec3 vDir;

float hash31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void main() {
  float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);

  // Deep summer-night sky, with the warm smudge of the festival on the horizon.
  vec3 low  = vec3(0.030, 0.036, 0.055);
  vec3 mid  = vec3(0.017, 0.022, 0.042);
  vec3 high = vec3(0.006, 0.008, 0.020);
  vec3 col = mix(low, mid, smoothstep(0.35, 0.55, h));
  col = mix(col, high, smoothstep(0.55, 0.95, h));

  float glowBand = exp(-pow((h - 0.50) * 9.0, 2.0));
  col += vec3(0.085, 0.040, 0.014) * glowBand;

  // Sparse stars — quantise the direction so they hold still.
  vec3 cell = floor(vDir * 200.0);
  float star = hash31(cell);
  float twinkle = step(0.9975, star);
  col += vec3(0.85, 0.88, 1.0) * twinkle * smoothstep(0.45, 0.9, h) * (0.35 + 0.65 * hash31(cell + 7.0));

  gl_FragColor = vec4(col, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FestivalStall() {
  const res = useMemo(() => {
    const tubTex = makeWoodTexture(512, '#7d5735', '#4a3018', '#a8825a', 3);
    // Clones share the uploaded image; only the tiling differs.
    const postTex = tubTex.clone();
    postTex.repeat.set(1.6, 1.6);
    postTex.needsUpdate = true;
    const backTex = tubTex.clone();
    backTex.repeat.set(2.4, 1.2);
    backTex.needsUpdate = true;
    const signTex = makeSignTexture();

    const tub = new THREE.MeshStandardMaterial({
      map: tubTex,
      color: '#c8b49a',
      roughness: 0.82,
      metalness: 0.0,
    });
    applySubmergedTint(tub);

    // The rail the players lean on catches the stall light, so it is lighter.
    const rail = new THREE.MeshStandardMaterial({
      map: tubTex,
      color: '#e0cbaa',
      roughness: 0.68,
      metalness: 0.0,
    });

    const post = new THREE.MeshStandardMaterial({
      map: postTex,
      color: '#9c8266',
      roughness: 0.88,
      metalness: 0.0,
    });

    const backWall = new THREE.MeshStandardMaterial({
      map: backTex,
      color: '#4c3f34',
      roughness: 0.95,
      metalness: 0.0,
    });

    const sign = new THREE.MeshStandardMaterial({
      map: signTex,
      roughness: 0.72,
      metalness: 0.0,
      emissiveMap: signTex,
      emissive: new THREE.Color('#3a2410'),
      emissiveIntensity: 0.35,
    });

    const ground = new THREE.MeshStandardMaterial({
      color: '#241d18',
      roughness: 1.0,
      metalness: 0.0,
    });

    const rope = new THREE.MeshStandardMaterial({
      color: '#6b5b42',
      roughness: 0.95,
      metalness: 0.0,
    });

    const perimeter = buildPerimeter(OUT_W + 0.05, OUT_D + 0.05, 0.34, 0.16);
    const skirt = buildSkirtGeometry(perimeter, SKIRT_TOP, SKIRT_H, 18);
    // ~0.52 m per red/white pair: the proportion of a real 紅白幕.
    const stripes = Math.max(8, Math.round(skirt.perimeter / 1.04));

    const cloth = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uStripes: { value: stripes },
        uRed: { value: new THREE.Color('#b8281f') },
        uWhite: { value: new THREE.Color('#f2ece0') },
        uWarm: { value: new THREE.Color('#ffcf9c') },
        uCool: { value: new THREE.Color('#3d5a78') },
        uLightDir: { value: new THREE.Vector3(0.1, 0.86, 0.5).normalize() },
      },
      vertexShader: CLOTH_VERTEX,
      fragmentShader: CLOTH_FRAGMENT,
      side: THREE.DoubleSide,
    });

    const night = new THREE.ShaderMaterial({
      vertexShader: NIGHT_VERTEX,
      fragmentShader: NIGHT_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });

    // Far enough behind the stall to read as sky, close enough to survive a
    // conservative camera far plane.
    const nightGeometry = new THREE.SphereGeometry(48, 32, 20);

    return {
      tubTex,
      postTex,
      backTex,
      signTex,
      tub,
      rail,
      post,
      backWall,
      sign,
      ground,
      rope,
      cloth,
      night,
      nightGeometry,
      skirtGeometry: skirt.geometry,
    };
  }, []);

  useEffect(() => {
    const r = res;
    return () => {
      r.tubTex.dispose();
      r.postTex.dispose();
      r.backTex.dispose();
      r.signTex.dispose();
      r.tub.dispose();
      r.rail.dispose();
      r.post.dispose();
      r.backWall.dispose();
      r.sign.dispose();
      r.ground.dispose();
      r.rope.dispose();
      r.cloth.dispose();
      r.night.dispose();
      r.nightGeometry.dispose();
      r.skirtGeometry.dispose();
    };
  }, [res]);

  useFrame((state) => {
    // One uniform write per frame — the whole skirt waves in the vertex shader.
    res.cloth.uniforms.uTime.value = state.clock.elapsedTime;
  });

  const railH = 0.20;
  const railT = RIM_T + 0.12;
  const railY = RIM_TOP - railH / 2;

  return (
    <group name="festival-stall">
      {/* Night sky. Drawn first, never occludes anything. */}
      <mesh
        geometry={res.nightGeometry}
        material={res.night}
        renderOrder={-1000}
        frustumCulled={false}
      />

      {/* Festival ground. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, GROUND_Y, 0]}
        material={res.ground}
        receiveShadow
      >
        <planeGeometry args={[80, 80]} />
      </mesh>

      {/* ---------------------------------------------------------------- tub */}
      {/* Long side walls carry the corners so the joints never show a gap. */}
      <mesh
        geometry={timber(RIM_T, TUB_H, TANK.depth + 2 * RIM_T)}
        material={res.tub}
        position={[-(TANK.halfWidth + RIM_T / 2), TUB_CY, 0]}
        castShadow
        receiveShadow
      />
      <mesh
        geometry={timber(RIM_T, TUB_H, TANK.depth + 2 * RIM_T)}
        material={res.tub}
        position={[TANK.halfWidth + RIM_T / 2, TUB_CY, 0]}
        castShadow
        receiveShadow
      />
      <mesh
        geometry={timber(TANK.width, TUB_H, RIM_T)}
        material={res.tub}
        position={[0, TUB_CY, TANK.halfDepth + RIM_T / 2]}
        castShadow
        receiveShadow
      />
      <mesh
        geometry={timber(TANK.width, TUB_H, RIM_T)}
        material={res.tub}
        position={[0, TUB_CY, -(TANK.halfDepth + RIM_T / 2)]}
        castShadow
        receiveShadow
      />

      {/* Bottom board — sits just under wherever the gravel is laid. */}
      <mesh
        geometry={timber(TANK.width, 0.16, TANK.depth)}
        material={res.tub}
        position={[0, TANK.floorY - 0.09, 0]}
        receiveShadow
      />

      {/* Top rail: a proud lip the light catches and the cloth hangs behind. */}
      <mesh
        geometry={timber(railT, railH, TANK.depth + 2 * railT)}
        material={res.rail}
        position={[-(TANK.halfWidth + railT / 2 - 0.03), railY, 0]}
        castShadow
        receiveShadow
      />
      <mesh
        geometry={timber(railT, railH, TANK.depth + 2 * railT)}
        material={res.rail}
        position={[TANK.halfWidth + railT / 2 - 0.03, railY, 0]}
        castShadow
        receiveShadow
      />
      <mesh
        geometry={timber(TANK.width + 0.06, railH, railT)}
        material={res.rail}
        position={[0, railY, TANK.halfDepth + railT / 2 - 0.03]}
        castShadow
        receiveShadow
      />
      <mesh
        geometry={timber(TANK.width + 0.06, railH, railT)}
        material={res.rail}
        position={[0, railY, -(TANK.halfDepth + railT / 2 - 0.03)]}
        castShadow
        receiveShadow
      />

      {/* -------------------------------------------------------- 赤い布 skirt */}
      {/* No shadow: the depth pass would ignore the wave and the scalloped hem
          and stamp a rectangle onto the ground. */}
      <mesh geometry={res.skirtGeometry} material={res.cloth} castShadow={false} />

      {/* ------------------------------------------------------- stall timber */}
      {[
        [-POST_X, POST_Z_BACK],
        [POST_X, POST_Z_BACK],
        [-POST_X, POST_Z_FRONT],
        [POST_X, POST_Z_FRONT],
      ].map(([px, pz]) => (
        <mesh
          key={`post-${px}-${pz}`}
          geometry={timber(0.24, POST_TOP - GROUND_Y, 0.24)}
          material={res.post}
          position={[px, (POST_TOP + GROUND_Y) / 2, pz]}
          castShadow
          receiveShadow
        />
      ))}

      {/* Head beams front and back, and the two side purlins. */}
      <mesh
        geometry={timber(POST_X * 2 + 0.4, 0.22, 0.22)}
        material={res.post}
        position={[0, BEAM_Y, POST_Z_BACK]}
        castShadow
      />
      <mesh
        geometry={timber(POST_X * 2 + 0.4, 0.22, 0.22)}
        material={res.post}
        position={[0, BEAM_Y, POST_Z_FRONT]}
        castShadow={false}
      />
      {/*
        Purlins and rafters deliberately cast NO shadow. The stall's lamps hang below
        them, so nothing here is between the light and the water — and a hard timber
        bar striping the middle of the tank would sit right across the play area.
      */}
      <mesh
        geometry={timber(0.2, 0.2, POST_Z_FRONT - POST_Z_BACK)}
        material={res.post}
        position={[-POST_X, BEAM_Y + 0.21, (POST_Z_FRONT + POST_Z_BACK) / 2]}
        castShadow={false}
      />
      <mesh
        geometry={timber(0.2, 0.2, POST_Z_FRONT - POST_Z_BACK)}
        material={res.post}
        position={[POST_X, BEAM_Y + 0.21, (POST_Z_FRONT + POST_Z_BACK) / 2]}
        castShadow={false}
      />
      {[-4.4, 0, 4.4].map((rx) => (
        <mesh
          key={`rafter-${rx}`}
          geometry={timber(0.14, 0.14, POST_Z_FRONT - POST_Z_BACK)}
          material={res.post}
          position={[rx, BEAM_Y + 0.21, (POST_Z_FRONT + POST_Z_BACK) / 2]}
          castShadow={false}
        />
      ))}

      {/* Back panel: stops the eye at the stall instead of the empty night. */}
      <mesh
        geometry={timber(POST_X * 2 + 0.4, POST_TOP - GROUND_Y, 0.16)}
        material={res.backWall}
        position={[0, (POST_TOP + GROUND_Y) / 2, POST_Z_BACK - 0.6]}
        receiveShadow
      />

      {/* ----------------------------------------------------------- the sign */}
      <group position={[0, 2.28, POST_Z_BACK + 0.22]} rotation={[0.08, 0, 0]}>
        <mesh geometry={timber(4.9, 1.24, 0.13)} material={res.post} castShadow receiveShadow />
        <mesh position={[0, 0, 0.071]} material={res.sign}>
          <planeGeometry args={[4.66, 1.06]} />
        </mesh>
        {/* Two short hanger straps up to the head beam. */}
        {[-1.9, 1.9].map((rx) => (
          <mesh key={`sign-rope-${rx}`} position={[rx, 0.73, -0.02]} material={res.rope}>
            <cylinderGeometry args={[0.022, 0.022, 0.28, 6]} />
          </mesh>
        ))}
      </group>
    </group>
  );
}
