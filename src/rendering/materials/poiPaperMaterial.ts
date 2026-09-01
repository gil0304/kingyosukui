/**
 * The washi paper of the poi (spec §52, §56).
 *
 * The paper is the emotional centre of the game: the player has to *see* it get
 * heavy, stretch, go translucent and finally give way, so every stage of
 *   Dry → Wet → VeryWet → Tearing        (§52)
 *   濡れる → 伸びる → 中央に小さな穴 → 穴が広がる   (§56)
 * is a visible, continuous change rather than a texture swap.
 *
 * Vertex stage
 *   The disc is treated as a loaded membrane: a uniform load (soaking) bows it
 *   into a paraboloid, a point load (a fish sitting on it) pulls it into a cone,
 *   and the whole sheet bulges outward at mid-radius before it fails. Normals
 *   are rebuilt from finite differences of the same displacement function, so
 *   the sag actually catches the light.
 *
 * Fragment stage
 *   Layered anisotropic value noise gives washi its long fibres; the wet blot
 *   spreads outward from the centre with an irregular front; the hole is a
 *   noise-perturbed radius that discards, with a frayed, darkened, thinning
 *   fibre band just outside it. Backlight bleeds through the sheet
 *   (subsurface-ish) and gets stronger the wetter and thinner it is.
 *
 * The material is deliberately NOT lit by the scene's light list: the poi hangs
 * in one known pool of warm stall light with a cool fill from the water, and
 * baking those two directions keeps the shader cheap enough to run on up to 8
 * poi at 60 fps.
 */

import * as THREE from 'three';

import { POI } from '@/game/core/constants';

export interface PoiPaperUniforms {
  /** 0..1 soak level — drives translucency, the blot and the sag. */
  uWetness: number;
  /** 0..1 hole size (spec §56). 0 = intact, 1 = almost nothing left. */
  uTear: number;
  /** Seconds, for the rim flutter and the underwater wobble. */
  uTime: number;
  /** Player accent, used ONLY as a thin band at the glued rim (spec §46). */
  uAccent: THREE.ColorRepresentation;
  /** 0..1 how far under the surface the paper is — cools and darkens it. */
  uSubmersion: number;
  /** 0..1 mechanical load: fish weight on the paper plus the lift. */
  uStress: number;
}

interface PoiPaperUniformMap {
  uWetness: THREE.IUniform<number>;
  uTear: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
  uAccent: THREE.IUniform<THREE.Color>;
  uSubmersion: THREE.IUniform<number>;
  uStress: THREE.IUniform<number>;
  /** Direction from the paper toward the warm stall spot (see Lighting.tsx). */
  uLightDir: THREE.IUniform<THREE.Vector3>;
  uWarm: THREE.IUniform<THREE.Color>;
  uCool: THREE.IUniform<THREE.Color>;
}

export type PoiPaperMaterial = THREE.ShaderMaterial & { uniforms: PoiPaperUniformMap };

const VERTEX_SHADER = /* glsl */ `
attribute float aRadius;
attribute float aAngle;

uniform float uWetness;
uniform float uTear;
uniform float uTime;
uniform float uSubmersion;
uniform float uStress;

varying float vRadius;
varying float vAngle;
varying vec3  vWorldPos;
varying vec3  vWorldNormal;

#define PAPER_RADIUS ${POI.paperRadius.toFixed(4)}

// Vertical displacement of the membrane at (r, a).
float sagAt(float r, float a) {
  float bowl = 1.0 - r * r;          // uniformly loaded sheet: paraboloid
  float cone = 1.0 - r;              // point load in the middle: cone
  float s = -(bowl * (0.030 + uWetness * 0.150) + cone * uStress * 0.300);

  // The rim is glued to the hoop but the sheet between the glue points flutters.
  float rim = pow(r, 3.0) * 0.016 * (0.30 + uSubmersion * 0.9 + uWetness * 0.4);
  s += rim * sin(a * 5.0 + uTime * 3.1);
  s += rim * 0.55 * sin(a * 8.0 - uTime * 2.2);

  // Water pushes back on the sheet while it is submerged.
  s += uSubmersion * 0.011 * sin(r * 7.0 - uTime * 2.6 + a * 2.0);
  return s;
}

// Full displaced position at (r, a).
vec3 shapeAt(float r, float a) {
  // 伸びる: wet, loaded paper visibly grows before it fails.
  float stretch = uWetness * 0.35 + uStress * 0.55 + uTear * 0.30;
  float rr = r * (1.0 + stretch * 0.075 * sin(r * 3.14159265));
  float rad = rr * PAPER_RADIUS;
  return vec3(rad * cos(a), sagAt(r, a), rad * sin(a));
}

void main() {
  vRadius = aRadius;
  vAngle = aAngle;

  vec3 p = shapeAt(aRadius, aAngle);

  // Rebuild the normal from the displacement field. cross(dP/da, dP/dr) points
  // at +Y for the undisplaced disc, which is the outward face of the paper.
  float rSafe = max(aRadius, 0.03);
  vec3 pBase = shapeAt(rSafe, aAngle);
  vec3 dR = shapeAt(rSafe + 0.03, aAngle) - pBase;
  vec3 dA = shapeAt(rSafe, aAngle + 0.05) - pBase;
  vec3 n = normalize(cross(dA, dR));

  vec4 world = modelMatrix * vec4(p, 1.0);
  vWorldPos = world.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * n);

  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform float uWetness;
uniform float uTear;
uniform float uTime;
uniform float uSubmersion;
uniform float uStress;
uniform vec3  uAccent;
uniform vec3  uLightDir;
uniform vec3  uWarm;
uniform vec3  uCool;

varying float vRadius;
varying float vAngle;
varying vec3  vWorldPos;
varying vec3  vWorldNormal;

float hash21(vec2 p) {
  p = fract(p * vec2(127.117, 311.743));
  p += dot(p, p + 41.317);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float s = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    s += amp * vnoise(p);
    p *= 2.03;
    amp *= 0.5;
  }
  return s;
}

// Long washi fibres: value noise squashed hard along one direction.
float strands(vec2 p, float ang) {
  float c = cos(ang);
  float s = sin(ang);
  vec2 q = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  return fbm(vec2(q.x * 84.0, q.y * 7.0));
}

void main() {
  // Paper-space coordinates: the UNDEFORMED disc, so the fibres do not swim
  // around while the sheet sags.
  vec2 pc = vec2(cos(vAngle), sin(vAngle)) * vRadius;
  // Periodic in angle by construction — used for the ragged tear outline.
  vec2 cp = vec2(cos(vAngle), sin(vAngle));

  float fibre = strands(pc, 0.0) * 0.40 + strands(pc, 1.15) * 0.34 + strands(pc, 2.35) * 0.26;
  float speck = vnoise(pc * 240.0);

  // ---------------------------------------------------------------- tearing
  float rag = fbm(cp * 5.0 + 3.7) - 0.5;
  float hole = uTear * 1.06 * (1.0 + rag * 0.42) * (0.62 + 0.42 * fibre);
  if (uTear > 0.0005 && vRadius < hole) discard;

  // Frayed band just outside the hole: fibres pulled loose, dirty and thin.
  float fray = 1.0 - smoothstep(hole, hole + 0.17, vRadius);
  fray *= step(0.0005, uTear);

  // ---------------------------------------------------------------- wetting
  // 濡れる: an irregular blot growing outward from the centre.
  float front = uWetness * 1.22 + (fbm(pc * 4.2 + 11.0) - 0.5) * 0.26;
  float wet = smoothstep(front + 0.16, front - 0.10, vRadius);
  wet *= smoothstep(0.0, 0.06, uWetness);
  wet = max(wet, uSubmersion * 0.9);
  wet = clamp(wet, 0.0, 1.0);

  // ----------------------------------------------------------------- colour
  vec3 dry = vec3(0.960, 0.940, 0.888);
  dry *= 0.90 + 0.17 * fibre;
  dry -= 0.040 * speck;
  vec3 wetCol = dry * vec3(0.60, 0.585, 0.565) + vec3(0.020, 0.028, 0.036);
  vec3 col = mix(dry, wetCol, wet);

  // Radial creases where a loaded, soaked sheet is about to give.
  float crease = pow(abs(sin(vAngle * 9.0 + rag * 2.4)), 12.0)
               * smoothstep(0.22, 0.9, uWetness + uStress * 0.5) * vRadius;
  col *= 1.0 - crease * 0.20;
  col *= 1.0 - fray * 0.45;

  // ------------------------------------------------------------- alpha/tear
  // Wet paper is translucent; the fray band thins out into individual fibres.
  float alpha = mix(0.965, 0.575, wet);
  alpha -= smoothstep(0.90, 1.0, uWetness) * 0.30 * step(0.87, vnoise(pc * 95.0));
  float thin = fray * (0.80 - fibre * 0.95);
  if (thin > 0.28) discard;                 // ragged fibre wisps at the edge
  alpha *= 1.0 - fray * 0.40;
  alpha = clamp(alpha, 0.0, 1.0);

  // --------------------------------------------------------------- lighting
  vec3 N = normalize(vWorldNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = normalize(uLightDir);

  // Wrapped diffuse — a sheet this thin never goes fully black.
  float wrap = dot(N, L) * 0.5 + 0.5;
  // Subsurface-ish: light arriving on the far side bleeds through, and thin
  // (wet, frayed) paper bleeds more.
  float through = pow(clamp(dot(-N, L), 0.0, 1.0), 1.5);
  float thinness = 0.42 + wet * 0.48 + fray * 0.35;

  vec3 lit = col * (uWarm * (0.34 + 0.66 * wrap) + uCool * 0.26);
  lit += col * uWarm * through * thinness * 1.25;
  lit += uWarm * (1.0 - fibre) * 0.02;      // faint fibre scatter

  // Wet sheen: sharper and stronger the wetter the sheet is.
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), mix(22.0, 150.0, wet)) * (0.04 + wet * 0.55);
  lit += uWarm * spec;

  // Under the surface everything cools down and loses contrast.
  lit = mix(lit, lit * vec3(0.52, 0.84, 0.92) + vec3(0.0, 0.012, 0.018), uSubmersion * 0.85);

  // Spec §46: the silhouette is identical for everyone; only a thin accent band
  // where the paper is glued to the hoop tells the poi apart.
  float band = smoothstep(0.885, 0.945, vRadius) * (1.0 - smoothstep(0.975, 1.0, vRadius));
  lit = mix(lit, mix(lit, uAccent, 0.60), band * 0.85);

  gl_FragColor = vec4(lit, alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * One material per poi — the uniforms are per-player state, so these must not
 * be shared. Eight of them is nothing; recreating one per frame is not.
 */
export function createPoiPaperMaterial(): PoiPaperMaterial {
  const uniforms: PoiPaperUniformMap = {
    uWetness: { value: 0 },
    uTear: { value: 0 },
    uTime: { value: 0 },
    uAccent: { value: new THREE.Color('#e0483a') },
    uSubmersion: { value: 0 },
    uStress: { value: 0 },
    // Matches the warm stall spot in 'FestivalLighting'.
    uLightDir: { value: new THREE.Vector3(0.08, 0.94, 0.33).normalize() },
    uWarm: { value: new THREE.Color('#ffd2a0').multiplyScalar(1.05) },
    uCool: { value: new THREE.Color('#3f7f8c') },
  };

  const material = new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as { [k: string]: THREE.IUniform },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: true,
    depthTest: true,
  }) as unknown as PoiPaperMaterial;

  material.name = 'poi.paper';
  return material;
}

/** Partial update — only the fields that are present are written. */
export function setPoiPaperUniforms(
  m: PoiPaperMaterial,
  u: Partial<PoiPaperUniforms>,
): void {
  const un = m.uniforms;
  if (u.uWetness !== undefined) un.uWetness.value = u.uWetness;
  if (u.uTear !== undefined) un.uTear.value = u.uTear;
  if (u.uTime !== undefined) un.uTime.value = u.uTime;
  if (u.uSubmersion !== undefined) un.uSubmersion.value = u.uSubmersion;
  if (u.uStress !== undefined) un.uStress.value = u.uStress;
  if (u.uAccent !== undefined) un.uAccent.value.set(u.uAccent);
}
