/**
 * Tiny dependency-free math helpers.
 *
 * IMPORTANT: this module (and everything it feeds — the fish/poi/capture
 * simulation) must stay free of 'three' imports so the authoritative
 * simulation can run inside the Node.js game server.
 */

export const TAU = Math.PI * 2;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export const vcopy = (out: Vec3, a: Vec3): Vec3 => {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
};

export const vset = (out: Vec3, x: number, y: number, z: number): Vec3 => {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
};

export const vadd = (out: Vec3, a: Vec3, b: Vec3): Vec3 =>
  vset(out, a.x + b.x, a.y + b.y, a.z + b.z);

export const vsub = (out: Vec3, a: Vec3, b: Vec3): Vec3 =>
  vset(out, a.x - b.x, a.y - b.y, a.z - b.z);

export const vscale = (out: Vec3, a: Vec3, s: number): Vec3 =>
  vset(out, a.x * s, a.y * s, a.z * s);

export const vaddScaled = (out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 =>
  vset(out, a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);

export const vlenSq = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z;
export const vlen = (a: Vec3): number => Math.sqrt(vlenSq(a));

export const vdistSq = (a: Vec3, b: Vec3): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};

export const vdist = (a: Vec3, b: Vec3): number => Math.sqrt(vdistSq(a, b));

export const vnormalize = (out: Vec3, a: Vec3): Vec3 => {
  const l = vlen(a);
  return l > 1e-8 ? vscale(out, a, 1 / l) : vset(out, 0, 0, 0);
};

export const vclampLength = (out: Vec3, a: Vec3, max: number): Vec3 => {
  const l = vlen(a);
  return l > max && l > 1e-8 ? vscale(out, a, max / l) : vcopy(out, a);
};

export const vlerp = (out: Vec3, a: Vec3, b: Vec3, t: number): Vec3 =>
  vset(out, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const clamp01 = (v: number): number => clamp(v, 0, 1);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const inverseLerp = (a: number, b: number, v: number): number =>
  Math.abs(b - a) < 1e-9 ? 0 : (v - a) / (b - a);

export const remap = (v: number, a0: number, a1: number, b0: number, b1: number): number =>
  lerp(b0, b1, clamp01(inverseLerp(a0, a1, v)));

export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01(inverseLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
};

/**
 * Frame-rate independent exponential approach.
 * 'smoothTime' is roughly the time to close ~63% of the gap.
 */
export const damp = (current: number, target: number, smoothTime: number, dt: number): number => {
  if (smoothTime <= 1e-6) return target;
  const t = 1 - Math.exp(-dt / smoothTime);
  return current + (target - current) * t;
};

export const dampVec3 = (out: Vec3, current: Vec3, target: Vec3, smoothTime: number, dt: number): Vec3 => {
  if (smoothTime <= 1e-6) return vcopy(out, target);
  const t = 1 - Math.exp(-dt / smoothTime);
  return vset(
    out,
    current.x + (target.x - current.x) * t,
    current.y + (target.y - current.y) * t,
    current.z + (target.z - current.z) * t,
  );
};

/** Critically-damped spring — smoother than 'damp' for things the eye tracks. */
export const springDamp = (
  current: number,
  velocity: number,
  target: number,
  smoothTime: number,
  dt: number,
): [value: number, velocity: number] => {
  const omega = 2 / Math.max(smoothTime, 1e-4);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (velocity + omega * change) * dt;
  const newVel = (velocity - omega * temp) * exp;
  const newVal = target + (change + temp) * exp;
  return [newVal, newVel];
};

export const wrapAngle = (a: number): number => {
  let r = (a + Math.PI) % TAU;
  if (r < 0) r += TAU;
  return r - Math.PI;
};

export const angleLerp = (a: number, b: number, t: number): number => a + wrapAngle(b - a) * t;

/** Rotate 'current' toward 'target' by at most 'maxDelta' radians. */
export const rotateTowards = (current: number, target: number, maxDelta: number): number => {
  const d = wrapAngle(target - current);
  if (Math.abs(d) <= maxDelta) return wrapAngle(target);
  return wrapAngle(current + Math.sign(d) * maxDelta);
};

/** Deterministic 32-bit PRNG (mulberry32) — reproducible fish behaviour for tests. */
export const createRng = (seed: number) => {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo: number, hi: number) => lo + next() * (hi - lo),
    int: (lo: number, hi: number) => Math.floor(lo + next() * (hi - lo + 1)),
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)] as T,
    sign: () => (next() < 0.5 ? -1 : 1),
  };
};

export type Rng = ReturnType<typeof createRng>;

/** Cheap 1D value noise — used for wandering fish and water motion. */
export const noise1 = (x: number): number => {
  const i = Math.floor(x);
  const f = x - i;
  const h = (n: number) => {
    let t = Math.imul(n ^ 0x27d4eb2d, 0x165667b1);
    t ^= t >>> 15;
    return (t >>> 0) / 4294967296;
  };
  const u = f * f * (3 - 2 * f);
  return lerp(h(i), h(i + 1), u) * 2 - 1;
};

export const nowSeconds = (): number =>
  (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
