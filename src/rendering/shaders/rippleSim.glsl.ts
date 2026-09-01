/**
 * Ripple field simulation shader (spec §61, §62).
 *
 * Solves the discrete 2D wave equation on a ping-pong render target:
 *
 *     next = 2*cur - prev + K * laplacian(cur)
 *
 * The whole field lives in one RGBA texture so a single ping-pong pair is enough:
 *
 *     r = current height   g = previous height   b,a = height gradient (d/du, d/dv)
 *
 * ENCODING — every channel is stored biased into 0..1 as 'v * 0.5 + 0.5', *even when
 * the target is half-float*. Some mobile GPUs cannot render to float targets at all and
 * fall back to an 8-bit target; keeping one encoding for both means consumers of the
 * texture (water surface, caustics) never need to know which path was taken.
 *
 * GLSL is exported as plain template strings so no webpack loader is required.
 */

/** Maximum impulses injected in a single simulation step. Must match the uniform array. */
export const RIPPLE_MAX_IMPULSES = 16;

/**
 * Gradient channels are stored as '(hRight - hLeft) * RIPPLE_GRADIENT_SCALE'.
 * Consumers normally just multiply by their own strength, but the scale is exported
 * so a physically-correct slope can be recovered if ever needed.
 */
export const RIPPLE_GRADIENT_SCALE = 6.0;

/** Shared decode helper — every module that samples the ripple texture uses this. */
export const RIPPLE_DECODE_GLSL = /* glsl */ `
// r = height, g = previous height, ba = gradient. All biased into 0..1 (see rippleSim.glsl.ts).
vec4 decodeRipple(vec4 s) {
  return (s - 0.5) * 2.0;
}
`;

/**
 * Fullscreen-triangle vertex shader. The geometry is three clip-space vertices, so the
 * camera is irrelevant — we deliberately bypass the matrices to keep the pass exact.
 */
export const RIPPLE_VERT = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const RIPPLE_SIM_FRAG = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform sampler2D uState;
/** 1 / textureSize. */
uniform vec2 uTexel;
/**
 * Per-axis laplacian weight. The tank is wider than it is deep but the texture is square,
 * so a texel covers more world space along u than along v. Without this correction a
 * circular splash would spread as an ellipse.
 */
uniform vec2 uAxisWeight;
/** c^2 * dt^2 in grid units. Stability needs uK * (uAxisWeight.x + uAxisWeight.y) < 1. */
uniform float uK;
uniform float uDamping;
/** 1.0 on the first substep of a frame only, so queued impulses are injected once. */
uniform float uInject;
uniform int uImpulseCount;
/** xy = centre in uv, z = radius along u, w = amplitude. */
uniform vec4 uImpulses[${RIPPLE_MAX_IMPULSES}];
/** TANK.width / TANK.depth — turns the u radius into the matching v radius. */
uniform float uRadiusAspect;

float decodeH(float s) { return (s - 0.5) * 2.0; }
float encodeH(float v) { return clamp(v * 0.5 + 0.5, 0.0, 1.0); }

void main() {
  vec4 state = texture2D(uState, vUv);
  float cur = decodeH(state.r);
  float prev = decodeH(state.g);

  // Neighbours use CLAMP_TO_EDGE wrapping, which is a Neumann boundary — exactly the
  // reflecting behaviour a real tank wall has.
  float hl = decodeH(texture2D(uState, vUv - vec2(uTexel.x, 0.0)).r);
  float hr = decodeH(texture2D(uState, vUv + vec2(uTexel.x, 0.0)).r);
  float hd = decodeH(texture2D(uState, vUv - vec2(0.0, uTexel.y)).r);
  float hu = decodeH(texture2D(uState, vUv + vec2(0.0, uTexel.y)).r);

  float lap = uAxisWeight.x * (hl + hr) + uAxisWeight.y * (hd + hu)
            - 2.0 * (uAxisWeight.x + uAxisWeight.y) * cur;

  float next = (2.0 * cur - prev + uK * lap) * uDamping;

  float bump = 0.0;
  if (uInject > 0.5 && uImpulseCount > 0) {
    for (int i = 0; i < ${RIPPLE_MAX_IMPULSES}; i++) {
      if (i >= uImpulseCount) break;
      vec4 imp = uImpulses[i];
      vec2 d = vUv - imp.xy;
      d.x /= max(imp.z, 1e-4);
      d.y /= max(imp.z * uRadiusAspect, 1e-4);
      // Gaussian bump: a hard disc would inject high frequencies the grid cannot carry.
      bump += imp.w * exp(-dot(d, d) * 3.0);
    }
  }
  next += bump;

  // Perfectly reflecting walls make the tank ring forever; bleed energy off in a narrow
  // band so splashes still bounce once or twice but always settle.
  vec2 edge = min(vUv, 1.0 - vUv);
  float band = smoothstep(0.0, 0.05, min(edge.x, edge.y));
  next *= mix(0.985, 1.0, band);

  float gx = (hr - hl) * ${RIPPLE_GRADIENT_SCALE.toFixed(1)};
  float gy = (hu - hd) * ${RIPPLE_GRADIENT_SCALE.toFixed(1)};

  // The bump goes into the stored PREVIOUS height as well, giving it zero initial
  // velocity. Injecting into the current height alone would also hand the impulse a
  // shove, and the bump would keep growing for a step instead of spreading as a ring.
  gl_FragColor = vec4(encodeH(next), encodeH(cur + bump), encodeH(gx), encodeH(gy));
}
`;
