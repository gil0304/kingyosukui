/**
 * Caustics shader (spec §63).
 *
 * Light focused by the moving surface and projected onto the gravel. The pattern is a
 * pair of animated voronoi networks — caustic light concentrates where neighbouring
 * refracted rays converge, which is exactly what a tight 'pow(1 - F1, k)' looks like —
 * warped by a slow sine distortion and, crucially, by the RIPPLE FIELD GRADIENT so the
 * bright lines genuinely follow the waves overhead instead of animating independently.
 *
 * Additively blended over the floor, so the "colour" here is pure added light.
 */

import { RIPPLE_DECODE_GLSL } from './rippleSim.glsl';

export const CAUSTICS_VERT = /* glsl */ `
precision highp float;

varying vec2 vPlaneUv;
varying vec3 vWorldPos;

void main() {
  vPlaneUv = uv;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export const CAUSTICS_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform sampler2D uRipple;
uniform vec2 uTankSize;
uniform float uIntensity;
uniform float uScale;
uniform float uRippleWarp;
uniform vec3 uWarmColor;
uniform vec3 uCoolColor;
uniform float uQuality;
/** Per-channel sample offset — real caustics fringe because water is dispersive. */
uniform float uDispersion;

varying vec2 vPlaneUv;
varying vec3 vWorldPos;

${RIPPLE_DECODE_GLSL}

vec2 hash22(vec2 p) {
  vec2 q = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(q) * 43758.5453123);
}

/** Distance to the nearest animated feature point (voronoi F1). */
float voronoiF1(vec2 p, float t) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  float best = 8.0;

  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash22(cell + g);
      // Feature points orbit their cell so the network breathes instead of scrolling.
      o = 0.5 + 0.42 * sin(t + 6.283185307 * o);
      vec2 r = g + o - f;
      best = min(best, dot(r, r));
    }
  }
  return sqrt(best);
}

float causticLayer(vec2 p, float t, float sharpness) {
  return pow(clamp(1.0 - voronoiF1(p, t), 0.0, 1.0), sharpness);
}

/** Full caustic network at one chromatic offset. */
float causticNetwork(vec2 p, float t) {
  // Slow sine distortion: the surface is never a regular grid, so neither is its focus.
  vec2 warp = vec2(
    sin(p.y * 0.9 + t * 0.55),
    cos(p.x * 0.8 - t * 0.47)
  ) * 0.22;

  float a = causticLayer(p + warp, t * 0.85, 7.0);
  float b = causticLayer(p * 1.87 + vec2(4.13, -2.71) - warp, t * 1.25, 5.0);

  // Summing gives soft blobs; the product term restores the crisp bright intersections
  // where two focus lines cross, which is what reads as "caustics" rather than "noise".
  float c = a * 0.55 + b * 0.35 + a * b * 1.7;

#ifdef CAUSTICS_QUALITY_HIGH
  float d = causticLayer(p * 3.4 + vec2(-1.9, 6.2), t * 1.7, 4.0);
  c += d * 0.18 * uQuality;
#endif

  return c;
}

void main() {
  // The floor plane is built at exactly TANK.width x TANK.depth, so plane uv and the
  // ripple field's uv are the same parameterisation.
  vec2 ruv = vWorldPos.xz / uTankSize + 0.5;
  vec4 rip = decodeRipple(texture2D(uRipple, clamp(ruv, 0.0, 1.0)));

  // The surface slope displaces where the light lands on the floor: a tilted patch of
  // water throws its focus sideways. That is the whole reason the caustics track waves.
  vec2 p = vWorldPos.xz * uScale + rip.ba * uRippleWarp;
  float t = uTime;

  float r = causticNetwork(p + vec2(uDispersion, 0.0), t);
  float g = causticNetwork(p, t);
  float b = causticNetwork(p - vec2(uDispersion, 0.0), t);
  vec3 caustic = vec3(r, g, b);

  // A ripple passing overhead momentarily focuses much harder than a flat surface does.
  caustic *= 1.0 + clamp(abs(rip.r) * 3.5, 0.0, 1.8);

  // Colour (spec §64): the stall lights hang over the rim, so the light reaching the
  // gravel near the walls is still warm; by the middle of the tank the column has
  // absorbed the red out of it and only blue-green survives.
  vec2 edge = abs(vPlaneUv - 0.5) * 2.0;
  float toWall = clamp(max(edge.x, edge.y), 0.0, 1.0);
  vec3 tint = mix(uCoolColor, uWarmColor, smoothstep(0.35, 1.0, toWall));
  // The brightest cores burn toward white the way focused light does.
  tint = mix(tint, vec3(1.0), clamp(g - 0.75, 0.0, 1.0) * 0.5);

  // Fade at the plane border so the projection never shows a rectangular edge.
  float vignette = (1.0 - smoothstep(0.86, 1.0, edge.x)) * (1.0 - smoothstep(0.90, 1.0, edge.y));

  vec3 color = caustic * tint * uIntensity * vignette;
  gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);

  #include <colorspace_fragment>
}
`;
