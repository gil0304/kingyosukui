/**
 * Water surface shader (spec §60, §61).
 *
 * Explicitly NOT "a blue translucent plane". Every term the spec asks for is here:
 *
 *   vertex   — 3–4 summed Gerstner waves with real geometric displacement and the
 *              analytic normal of the same sum, plus the ripple field's height and
 *              gradient so a poi breaking the surface makes a genuine spreading ring.
 *   fragment — screen-space refraction through the scene colour FBO, Beer-Lambert
 *              absorption driven by the reconstructed water column thickness, Fresnel,
 *              an analytic night sky plus lantern speculars, shoreline foam, and an
 *              animated FBM detail normal so the surface is never mirror-flat.
 *
 * Compiled by three as ESSL 3.00 with the 'texture2D'/'varying' compatibility defines,
 * so plain GLSL1-style source is correct here. Keep every literal a float literal.
 *
 * 'WATER_QUALITY_HIGH' is defined by createWaterMaterial on the high-quality path.
 */

import { RIPPLE_DECODE_GLSL } from './rippleSim.glsl';

export const WATER_VERT = /* glsl */ `
precision highp float;

uniform float uTime;
uniform sampler2D uRipple;
/** Tank width / depth — maps world XZ onto the ripple field's 0..1 uv. */
uniform vec2 uTankSize;
uniform float uWaveAmplitude;
uniform float uWaveSpeed;
uniform float uWaveSteepness;
uniform float uRippleHeight;
uniform float uRippleNormal;

varying vec3 vWorldPos;
varying vec3 vWaveNormal;
varying float vViewZ;
varying float vRippleH;
varying float vCrest;

${RIPPLE_DECODE_GLSL}

/**
 * One Gerstner wave, accumulated in place. 'disp' is the world-space offset, 'nrm' the
 * running analytic normal (GPU Gems 1 §1.2 form: start at (0,1,0) and subtract).
 * The wave phase uses the UNDISPLACED position, which is what makes the sum stable.
 */
void gerstner(
  vec2 dir, float amp, float wavelength, float speed, float steepness,
  vec2 p, float t, inout vec3 disp, inout vec3 nrm
) {
  float w = 6.283185307 / wavelength;
  // Q is normalised by w*A so raising the amplitude never folds the crests over.
  float q = steepness / max(w * amp * 4.0, 1e-4);
  float f = w * dot(dir, p) + speed * w * t;
  float c = cos(f);
  float s = sin(f);
  float wa = w * amp;

  disp.x += q * amp * dir.x * c;
  disp.z += q * amp * dir.y * c;
  disp.y += amp * s;

  nrm.x -= dir.x * wa * c;
  nrm.z -= dir.y * wa * c;
  nrm.y -= q * wa * s;
}

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec2 p = world.xz;
  float t = uTime * uWaveSpeed;

  vec3 disp = vec3(0.0);
  vec3 nrm = vec3(0.0, 1.0, 0.0);
  float a = uWaveAmplitude;
  float k = uWaveSteepness;

  // A long swell, a cross swell, and short chop. Directions are deliberately
  // non-parallel and the wavelengths non-harmonic so the sum never visibly repeats.
  gerstner(normalize(vec2( 1.00,  0.12)), 0.045 * a, 7.20, 0.85, 0.55 * k, p, t, disp, nrm);
  gerstner(normalize(vec2( 0.42,  0.91)), 0.030 * a, 4.10, 1.05, 0.45 * k, p, t, disp, nrm);
  gerstner(normalize(vec2(-0.75,  0.66)), 0.018 * a, 2.35, 1.35, 0.40 * k, p, t, disp, nrm);
#ifdef WATER_QUALITY_HIGH
  gerstner(normalize(vec2( 0.18, -0.98)), 0.010 * a, 1.35, 1.70, 0.35 * k, p, t, disp, nrm);
#endif

  // Ripple field: extra displacement plus a normal perturbation from its gradient.
  // This is the term that turns a poi entering the water into a real expanding ring.
  vec2 ruv = p / uTankSize + 0.5;
  vec4 rip = decodeRipple(texture2D(uRipple, clamp(ruv, 0.0, 1.0)));
  float inside = step(0.0, min(ruv.x, ruv.y)) * step(max(ruv.x, ruv.y), 1.0);
  rip *= inside;

  // Hard ceiling: a runaway impulse in the wave field must dent the surface,
  // never fold the whole plane across the camera.
  disp.y += clamp(rip.r * uRippleHeight, -0.35, 0.35);
  nrm.x -= rip.b * uRippleNormal;
  nrm.z -= rip.a * uRippleNormal;

  vec3 wp = world.xyz + disp;
  vWorldPos = wp;
  vWaveNormal = normalize(nrm);
  vRippleH = rip.r;
  // Crest factor drives foam on the wave tops without another texture fetch.
  vCrest = clamp(disp.y / max(0.10 * a + 1e-4, 1e-4), -1.0, 1.0);

  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vViewZ = mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

export const WATER_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform sampler2D uRipple;
uniform sampler2D uRefraction;
uniform sampler2D uSceneDepth;
uniform float uCameraNear;
uniform float uCameraFar;
uniform vec2 uResolution;
uniform vec3 uShallowColor;
uniform vec3 uDeepColor;
uniform vec3 uFoamColor;
uniform vec3 uLightDir;
uniform vec3 uLanternPositions[4];
uniform vec3 uLanternColors[4];
uniform float uQuality;
uniform vec2 uTankSize;
uniform float uRefractionStrength;
uniform float uAbsorption;
uniform float uMaxFresnel;
uniform float uColumnDepth;
uniform float uDetailStrength;
uniform float uRippleDetail;
uniform float uFoamWidth;
uniform float uSpecularBoost;

varying vec3 vWorldPos;
varying vec3 vWaveNormal;
varying float vViewZ;
varying float vRippleH;
varying float vCrest;

${RIPPLE_DECODE_GLSL}

float hash12(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

/** Value noise with analytic derivatives — one evaluation gives value AND slope. */
vec3 noised(vec2 x) {
  vec2 i = floor(x);
  vec2 f = fract(x);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);

  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));

  float k1 = b - a;
  float k2 = c - a;
  float k3 = a - b - c + d;

  return vec3(
    a + k1 * u.x + k2 * u.y + k3 * u.x * u.y,
    du.x * (k1 + k3 * u.y),
    du.y * (k2 + k3 * u.x)
  );
}

/**
 * Animated FBM detail. Returns (height, d/dx, d/dy). Octaves drift in opposite
 * directions so the detail shears instead of sliding as one sheet.
 */
vec3 detailFbm(vec2 p, float t) {
  vec3 sum = vec3(0.0);
  mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);

  vec2 q = p * 1.9 + vec2(t * 0.11, t * 0.07);
  vec3 n = noised(q);
  sum += vec3(n.x, n.yz * 1.9) * 0.55;

  q = rot * p * 4.3 + vec2(-t * 0.19, t * 0.13);
  n = noised(q);
  sum += vec3(n.x, n.yz * 4.3) * 0.28;

#ifdef WATER_QUALITY_HIGH
  q = rot * rot * p * 9.1 + vec2(t * 0.26, -t * 0.22);
  n = noised(q);
  sum += vec3(n.x, n.yz * 9.1) * 0.14 * uQuality;
#endif

  sum.x -= 0.485;
  return sum;
}

/** Positive linear distance from the camera for a raw depth-buffer sample. */
float linearDepth(float d) {
  return (uCameraNear * uCameraFar) / (uCameraFar - d * (uCameraFar - uCameraNear));
}

/** Analytic night sky: deep blue overhead, warm festival haze toward the horizon. */
vec3 nightSky(vec3 dir) {
  float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 horizon = vec3(0.150, 0.098, 0.070);
  vec3 zenith = vec3(0.018, 0.028, 0.052);
  return mix(horizon, zenith, pow(h, 0.65));
}

void main() {
  vec2 screenUv = gl_FragCoord.xy / uResolution;
  float waterZ = -vViewZ;

  // --- surface normal: Gerstner sum + ripple gradient + FBM detail ---------------
  vec3 detail = detailFbm(vWorldPos.xz, uTime);
  vec3 n = normalize(vWaveNormal);
  n = normalize(vec3(
    n.x - detail.y * uDetailStrength,
    n.y,
    n.z - detail.z * uDetailStrength
  ));

  // A 512-texel ripple field resolves finer detail than even a 220x140 vertex grid, so
  // re-read its gradient per pixel. Without this a small ring loses its edge between
  // vertices and reads as a soft blob instead of a wave front.
  vec2 rippleUv = clamp(vWorldPos.xz / uTankSize + 0.5, 0.0, 1.0);
  vec4 ripple = decodeRipple(texture2D(uRipple, rippleUv));
  n = normalize(vec3(
    n.x - ripple.b * uRippleDetail,
    n.y,
    n.z - ripple.a * uRippleDetail
  ));

  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  // Grazing angles have almost no refraction to show, and steep normals there produce
  // long smears; fold the view angle into the bend to keep the image honest.
  float facing = clamp(dot(n, viewDir), 0.0, 1.0);

  // --- water column thickness ----------------------------------------------------
  float sceneZ0 = linearDepth(texture2D(uSceneDepth, screenUv).x);
  float thickness0 = max(sceneZ0 - waterZ, 0.0);

  // --- screen-space refraction ---------------------------------------------------
  float bend = uRefractionStrength * (0.30 + 0.70 * clamp(thickness0 / uColumnDepth, 0.0, 1.0));
  bend *= mix(0.35, 1.0, facing);
  vec2 offset = vec2(n.x, n.z) * bend;
  // Clamp so the tap can never leave the frame — an off-frame tap mirrors whatever is
  // at the screen border into the water and reads as a hard seam.
  vec2 refractUv = clamp(screenUv + offset, vec2(0.0015), vec2(0.9985));

  float sceneZ = linearDepth(texture2D(uSceneDepth, refractUv).x);
  // If the bent tap landed on something IN FRONT of the water (a poi handle, the rim),
  // that pixel is not underwater; fall back to the straight tap.
  if (sceneZ < waterZ) {
    refractUv = screenUv;
    sceneZ = sceneZ0;
  }
  float thickness = max(sceneZ - waterZ, 0.0);
  vec3 refracted = texture2D(uRefraction, refractUv).rgb;

  // --- Beer-Lambert absorption ---------------------------------------------------
  // Red is absorbed fastest, which is what makes deep water read as blue-green (§64).
  vec3 sigma = vec3(0.78, 0.34, 0.24) * uAbsorption;
  vec3 transmit = exp(-sigma * thickness);
  vec3 body = mix(uShallowColor, uDeepColor, clamp(thickness / uColumnDepth, 0.0, 1.0));
  vec3 underwater = refracted * transmit + body * (1.0 - transmit);

  // --- reflection: night sky + lantern glints (§60 "提灯が水に映る") --------------
  vec3 reflectDir = reflect(-viewDir, n);
  vec3 reflection = nightSky(reflectDir);

  for (int i = 0; i < 4; i++) {
    vec3 toLantern = uLanternPositions[i] - vWorldPos;
    float dist = length(toLantern);
    if (dist < 1e-3) continue;
    vec3 l = toLantern / dist;
    vec3 h = normalize(l + viewDir);
    float nh = max(dot(n, h), 0.0);
    // A tight core for the mirror image plus a wide skirt for the smeared reflection
    // a rippled surface always has. The core lobe is ~5 degrees wide, so the waves
    // shatter it into the scattered sparkle a real lantern makes on moving water.
    float glint = pow(nh, 180.0) + pow(nh, 12.0) * 0.12;
    // Gentle falloff only: the rig is at a fixed distance, so this is shaping, not physics.
    float atten = 1.0 / (1.0 + dist * dist * 0.012);
    reflection += uLanternColors[i] * glint * atten * uSpecularBoost;
  }

  vec3 keyDir = normalize(uLightDir);
  float keyNh = max(dot(n, normalize(keyDir + viewDir)), 0.0);
  reflection += vec3(1.00, 0.94, 0.82) * pow(keyNh, 96.0) * 0.30 * uSpecularBoost;

  float fresnel = 0.02 + 0.98 * pow(1.0 - facing, 5.0);
  // Real water is a mirror at grazing incidence, and the far half of this tank IS seen
  // at grazing incidence. Physically honest here means the back of the tank turns into
  // an opaque sheen and the fish swimming in it become untargetable, so the mirror is
  // capped: the surface still glints, but you can always see what is under it.
  fresnel = min(fresnel, uMaxFresnel);
  vec3 color = mix(underwater, reflection, clamp(fresnel, 0.0, 1.0));

  // --- foam ----------------------------------------------------------------------
  // Where the scene surfaces almost touch the water plane: tank walls, gravel shallows,
  // a poi frame or a fish back breaking through.
  float shore = 1.0 - smoothstep(0.0, uFoamWidth, thickness0);
  shore *= shore;
  // Ripple crests and steep wave tops throw a little foam of their own.
  float crestFoam = smoothstep(0.35, 0.85, abs(vRippleH)) * 0.55
                  + smoothstep(0.55, 1.0, vCrest) * 0.18;
  float foam = clamp(shore + crestFoam, 0.0, 1.0);
  // Break the line up so it never looks like a stroked outline.
  foam *= 0.55 + 0.45 * clamp(detail.x * 2.0 + 0.6, 0.0, 1.0);
  color = mix(color, uFoamColor, clamp(foam * 0.9, 0.0, 1.0));

  gl_FragColor = vec4(color, 1.0);

  #include <colorspace_fragment>
}
`;
