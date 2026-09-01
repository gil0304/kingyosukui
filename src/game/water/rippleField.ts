/**
 * GPU ripple field (spec §61, §62).
 *
 * A ping-pong pair of render targets running the discrete wave equation over the whole
 * water surface. Anything that touches the water — a poi entering or leaving, a fish
 * breaking the surface, a capture, two poi colliding — pushes an impulse in here and
 * gets a real spreading ring out of it, shared by the water surface shader (height +
 * normal perturbation) and the caustics (focus displacement).
 *
 * Design notes:
 *  - The simulation runs on a FIXED substep (1/180s) with an accumulator. The wave
 *    equation is only conditionally stable, so it must never see a variable dt.
 *  - Nothing is allocated per frame: the impulse queue is a preallocated Float32Array
 *    that doubles as the uniform payload.
 *  - Half-float targets are used where the GPU can render to them, with an 8-bit
 *    fallback for mobile GPUs that cannot. BOTH paths store values biased into 0..1
 *    ('v * 0.5 + 0.5'), so consumers of 'texture' never need to know which one is live.
 */

import * as THREE from 'three';

import { TANK } from '@/game/core/constants';
import { clamp } from '@/game/core/math';
import {
  RIPPLE_MAX_IMPULSES,
  RIPPLE_SIM_FRAG,
  RIPPLE_VERT,
} from '@/rendering/shaders/rippleSim.glsl';

/** Fixed simulation substep — the wave equation must never see a variable dt. */
const SUB_DT = 1 / 180;
const SUB_HZ = 1 / SUB_DT;
/** Upper bound on catch-up work after a stall, so a hitch cannot cascade. Must be even. */
const MAX_SUBSTEPS = 6;
/**
 * How fast a ripple front travels, in WORLD units per second. A poi splash crosses the
 * 8.6-unit depth of the tank in a little over four seconds, which reads as water rather
 * than as jelly (too slow) or as a shockwave (too fast).
 */
const TARGET_WAVE_SPEED = 2.0;
/**
 * CFL headroom. The scheme is stable while K * (wu + wv) < 1; 0.62 leaves a comfortable
 * margin for the half-float rounding that a strict-limit K would amplify.
 */
const CFL_BUDGET = 0.62;
/**
 * Per-substep amplitude decay. At 180 substeps/s this keeps ~76% of the amplitude per
 * second, so a ring survives four or five seconds while still always settling.
 */
const DAMPING = 0.9985;

/** Encoded value of "flat water" — every channel is biased by 0.5. */
const FLAT = 0.5;
const FLAT_COLOR = /* @__PURE__ */ new THREE.Color(FLAT, FLAT, FLAT);

/** Fullscreen triangle in clip space. One triangle beats two: no diagonal seam. */
function createFullscreenTriangle(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  );
  return geometry;
}

export class RippleField {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly _size: number;

  private rtRead: THREE.WebGLRenderTarget;
  private rtWrite: THREE.WebGLRenderTarget;

  private readonly scene: THREE.Scene;
  private readonly camera: THREE.OrthographicCamera;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;

  /** xy = uv centre, z = radius along u, w = signed amplitude. Doubles as the uniform. */
  private readonly impulses = new Float32Array(RIPPLE_MAX_IMPULSES * 4);
  private impulseCount = 0;

  private accumulator = 0;
  private disposed = false;
  /** Scratch for save/restore of the renderer clear colour — never allocate in a pass. */
  private readonly savedClearColor = new THREE.Color();

  /** True when the 8-bit fallback target is in use (no float render support). */
  readonly lowPrecision: boolean;

  constructor(renderer: THREE.WebGLRenderer, size = 512) {
    this.renderer = renderer;
    this._size = Math.max(64, Math.floor(size));

    // Rendering to a half-float target needs an explicit extension in WebGL2 and a few
    // mobile GPUs expose neither; fall back to 8-bit rather than producing a black field.
    const canFloat =
      renderer.extensions.has('EXT_color_buffer_half_float') ||
      renderer.extensions.has('EXT_color_buffer_float');
    this.lowPrecision = !canFloat;

    const options: THREE.RenderTargetOptions = {
      type: canFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      // Bilinear: the water shader samples this at arbitrary uv and NEAREST would
      // quantise the wave fronts into visible stair steps on a 15-unit-wide tank.
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      // Clamped edges give the laplacian a Neumann boundary — a reflecting tank wall.
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    };

    this.rtRead = new THREE.WebGLRenderTarget(this._size, this._size, options);
    this.rtWrite = new THREE.WebGLRenderTarget(this._size, this._size, options);

    // A texel is wider in world X than in world Z (the tank is 15 x 8.6 on a square
    // texture), so the laplacian must be weighted or a splash would spread as an ellipse.
    const du = TANK.width / this._size;
    const dv = TANK.depth / this._size;
    const wu = (dv / du) * (dv / du);

    // Derive K from the target wave speed rather than hard-coding it: the grid spacing
    // depends on 'size', so a fixed K would make a 256 field propagate twice as fast as
    // a 512 one. Clamped to the CFL budget in case a caller asks for a very small field.
    const speedRatio = TARGET_WAVE_SPEED / (dv * SUB_HZ);
    const k = Math.min(speedRatio * speedRatio, CFL_BUDGET / (wu + 1));

    this.geometry = createFullscreenTriangle();
    this.material = new THREE.ShaderMaterial({
      vertexShader: RIPPLE_VERT,
      fragmentShader: RIPPLE_SIM_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uState: { value: this.rtRead.texture },
        uTexel: { value: new THREE.Vector2(1 / this._size, 1 / this._size) },
        uAxisWeight: { value: new THREE.Vector2(wu, 1) },
        uK: { value: k },
        uDamping: { value: DAMPING },
        uInject: { value: 0 },
        uImpulseCount: { value: 0 },
        uImpulses: { value: this.impulses },
        uRadiusAspect: { value: TANK.width / TANK.depth },
      },
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    // The vertex shader writes clip space directly, so the camera only exists because
    // WebGLRenderer.render() demands one.
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.clearTargets();
  }

  /**
   * The field texture. r = height, g = previous height, ba = gradient, all biased 0..1.
   *
   * STABLE: 'update()' always runs an even number of substeps, so this returns the same
   * 'THREE.Texture' object for the lifetime of the field. Consumers may hold it.
   */
  get texture(): THREE.Texture {
    return this.rtRead.texture;
  }

  get size(): number {
    return this._size;
  }

  /**
   * Queue a disturbance at a world XZ position. Cheap enough to call from an event
   * handler; the impulse is applied on the next update().
   *
   * @param strength signed amplitude, roughly -1..1 — positive lifts the surface (a poi
   *                 pulling out, a splash landing back down), negative pushes it down
   *                 (something entering the water). Useful reference values:
   *                 poi entering -0.30, poi leaving +0.35, hard splash +0.70,
   *                 a fish breaking the surface +0.10, two poi colliding +0.15.
   * @param radius   world-space radius of the gaussian bump. The poi frame is 0.62, so
   *                 0.3..0.7 covers most of what touches this water.
   */
  addRipple(worldX: number, worldZ: number, strength: number, radius: number): void {
    // A non-finite impulse would poison the whole height field permanently
    // (the wave equation never forgets); refuse it at the door.
    if (!Number.isFinite(worldX) || !Number.isFinite(worldZ) || !Number.isFinite(strength)) return;
    // The wave equation never forgets: an oversized impulse rings for seconds.
    strength = Math.max(-1.2, Math.min(1.2, strength));
    if (this.disposed) return;
    if (!Number.isFinite(worldX) || !Number.isFinite(worldZ) || !Number.isFinite(strength)) {
      return;
    }

    const u = worldX / TANK.width + 0.5;
    const v = worldZ / TANK.depth + 0.5;
    // A little slack outside the tank so a splash right at the wall still shows its edge.
    if (u < -0.15 || u > 1.15 || v < -0.15 || v > 1.15) return;

    const amp = clamp(strength, -1.5, 1.5);
    if (Math.abs(amp) < 1e-4) return;
    const radiusU = Math.max(radius, 0.02) / TANK.width;

    let slot = this.impulseCount;
    if (slot >= RIPPLE_MAX_IMPULSES) {
      // Queue is full: evict the weakest pending impulse, but only if this one matters
      // more. Dropping the loudest splash of the frame would be the visible failure.
      let weakest = 0;
      let weakestAmp = Math.abs(this.impulses[3]);
      for (let i = 1; i < RIPPLE_MAX_IMPULSES; i++) {
        const a = Math.abs(this.impulses[i * 4 + 3]);
        if (a < weakestAmp) {
          weakestAmp = a;
          weakest = i;
        }
      }
      if (Math.abs(amp) <= weakestAmp) return;
      slot = weakest;
    } else {
      this.impulseCount = slot + 1;
    }

    const o = slot * 4;
    this.impulses[o] = u;
    this.impulses[o + 1] = v;
    this.impulses[o + 2] = radiusU;
    this.impulses[o + 3] = amp;
  }

  /** Advance the simulation. Safe to call with any dt, including 0 or a huge stall. */
  update(dt: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(dt) || dt <= 0) return;

    this.accumulator += Math.min(dt, 0.25);
    let steps = Math.floor(this.accumulator / SUB_DT);
    // Always run an EVEN number of substeps so the ping-pong ends on the buffer it
    // started on. That is what lets 'texture' be a stable object reference, which in
    // turn lets React components hold it as a prop instead of re-reading it per frame.
    steps -= steps % 2;
    if (steps <= 0) return;
    if (steps > MAX_SUBSTEPS) {
      steps = MAX_SUBSTEPS;
      this.accumulator = 0;
    } else {
      this.accumulator -= steps * SUB_DT;
    }

    const gl = this.renderer;
    const prevTarget = gl.getRenderTarget();
    const prevCubeFace = gl.getActiveCubeFace();
    const prevMipLevel = gl.getActiveMipmapLevel();
    const prevAutoClear = gl.autoClear;
    // The fullscreen triangle covers every texel, so clearing would be pure waste.
    gl.autoClear = false;

    const uniforms = this.material.uniforms;
    for (let i = 0; i < steps; i++) {
      uniforms.uState.value = this.rtRead.texture;
      // Impulses are injected on the first substep only — repeating them would
      // multiply the energy by the substep count.
      uniforms.uInject.value = i === 0 ? 1 : 0;
      uniforms.uImpulseCount.value = i === 0 ? this.impulseCount : 0;

      gl.setRenderTarget(this.rtWrite);
      gl.render(this.scene, this.camera);

      const swap = this.rtRead;
      this.rtRead = this.rtWrite;
      this.rtWrite = swap;
    }
    this.impulseCount = 0;

    gl.setRenderTarget(prevTarget, prevCubeFace, prevMipLevel);
    gl.autoClear = prevAutoClear;
  }

  /** Flatten the water instantly (used between rounds). */
  reset(): void {
    if (this.disposed) return;
    this.impulseCount = 0;
    this.accumulator = 0;
    this.clearTargets();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.rtRead.dispose();
    this.rtWrite.dispose();
  }

  /**
   * Fill both targets with the encoded "flat" value (0.5 on every channel).
   *
   * ORDER MATTERS: three converts the clear colour into the colour space of whatever
   * target is bound *at the moment setClearColor runs*. Binding the render target first
   * keeps the working (linear) space, so 0.5 really lands as 0.5 and not as sRGB 0.735.
   */
  private clearTargets(): void {
    const gl = this.renderer;
    const prevTarget = gl.getRenderTarget();
    const prevCubeFace = gl.getActiveCubeFace();
    const prevMipLevel = gl.getActiveMipmapLevel();
    gl.getClearColor(this.savedClearColor);
    const prevAlpha = gl.getClearAlpha();

    gl.setRenderTarget(this.rtRead);
    gl.setClearColor(FLAT_COLOR, FLAT);
    gl.clear(true, false, false);
    gl.setRenderTarget(this.rtWrite);
    gl.clear(true, false, false);

    gl.setRenderTarget(prevTarget, prevCubeFace, prevMipLevel);
    gl.setClearColor(this.savedClearColor, prevAlpha);
  }
}
