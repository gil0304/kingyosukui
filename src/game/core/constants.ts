/**
 * Global tuning constants for 巨大デジタル金魚すくい.
 *
 * World space (right-handed, three.js convention):
 *   +X : screen right          -X : screen left
 *   +Y : up (water surface = 0) -Y : down into the water
 *   +Z : toward the viewer      -Z : into the depth of the tank
 *
 * A player tilting their phone forward pushes the poi toward -Z ("奥へ").
 */

export const TANK = {
  /** Full inner width of the water volume. */
  width: 15.0,
  /** Full inner depth (near <-> far). */
  depth: 8.6,
  /** Distance from the water surface (y=0) down to the gravel floor. */
  waterDepth: 2.5,

  get halfWidth() {
    return TANK.width / 2;
  },
  get halfDepth() {
    return TANK.depth / 2;
  },
  /** y of the tank floor. */
  get floorY() {
    return -TANK.waterDepth;
  },
  /** y of the still water surface. */
  surfaceY: 0,
  /** Height of the wooden rim above the water line. */
  rimHeight: 0.55,
};

/** Region the fish are allowed to occupy (kept inside the tank walls). */
export const FISH_BOUNDS = {
  minX: -TANK.width / 2 + 0.55,
  maxX: TANK.width / 2 - 0.55,
  minZ: -TANK.depth / 2 + 0.5,
  maxZ: TANK.depth / 2 - 0.5,
  minY: -TANK.waterDepth + 0.28,
  maxY: -0.16,
};

/** Region a poi can be moved through. */
export const POI_BOUNDS = {
  minX: -TANK.width / 2 + 0.75,
  maxX: TANK.width / 2 - 0.75,
  minZ: -TANK.depth / 2 + 0.7,
  maxZ: TANK.depth / 2 - 0.7,
  /** Deepest the paper can be pushed. */
  minY: -TANK.waterDepth + 0.35,
  /** Highest the poi is lifted after a successful scoop. */
  maxY: 1.55,
};

export const POI = {
  /** Outer radius of the bamboo frame. */
  frameRadius: 0.62,
  /** Radius of the paper disc that fish must sit on. */
  paperRadius: 0.56,
  /**
   * Radius used for capture tests. Deliberately a touch beyond the paper edge:
   * at festival difficulty a fish brushing the rim counts as on (擦り気味でも
   * 乗った扱い — the game should feel generous, not forensic).
   */
  captureRadius: 0.58,
  /** Vertical tolerance above the paper for a fish to count as "on" the poi. */
  captureHeight: 0.42,
  frameThickness: 0.035,
  handleLength: 1.05,
  handleRadius: 0.032,

  /** Resting height while hovering above the water. */
  hoverY: 0.5,
  /** Default depth once submerged. */
  restDepth: -0.55,
  /** Height the poi must reach for a lift to resolve. */
  liftResolveY: 0.62,

  /** Critically damped follow time (seconds) for horizontal motion. */
  horizontalSmoothing: 0.085,
  /** Follow time for vertical motion. */
  verticalSmoothing: 0.06,

  /** Max horizontal speed, world units / second. */
  maxSpeed: 13.0,

  /** Soft body radius used for poi-vs-poi separation. */
  bodyRadius: 0.66,
  /** How hard two overlapping poi push each other apart (units/s per unit overlap). */
  separationStrength: 5.5,

  maxDurability: 100,
  /** Seconds before a broken poi is replaced. */
  respawnSeconds: 3.0,
  /** Score penalty when the paper tears (spec §57). */
  breakPenalty: 100,
};

export const WETNESS = {
  /** Wetness gained per second fully submerged. */
  gainPerSecond: 0.155,
  /** Wetness recovered per second while out of the water. */
  dryPerSecond: 0.055,
  /** Thresholds for Dry -> Wet -> VeryWet -> Tearing (spec §52). */
  wet: 0.3,
  veryWet: 0.62,
  tearing: 0.86,
};

export const DURABILITY = {
  /**
   * Load = fishWeight * liftAcceleration * wetnessModifier   (spec §54)
   * Damage per second = load * scale * danger, applied while lifting.
   *
   * Tuned so the tear is *watchable* (spec §56 wants 濡れる → 伸びる → 穴 →
   * 穴が広がる, not an instant pop): a violent 30 m/s² yank on a wet paper
   * holding a 出目金 runs ~83 damage/s, so the hole opens at ~0.5 s and the
   * paper gives way at ~1.2 s. A lift at or below 'gentleAccel' costs nothing.
   */
  loadScale: 0.62,
  /** Baseline lift acceleration that is considered "gentle" (m/s²). */
  gentleAccel: 2.6,
  /** Above this the lift is a violent yank. */
  violentAccel: 12.0,
  /** Wetness modifier curve: 1 + wetness^2 * factor. */
  wetnessFactor: 3.4,
  /** Continuous soak damage per second while submerged (paper softening). */
  soakPerSecond: 1.1,
  /** Extra damage per second per kg of fish resting on the paper. */
  weightStressPerSecond: 1.6,
  /** Damage applied instantly when a fish lands hard on the paper. */
  impactDamage: 2.2,
};

export const CAPTURE = {
  /** Seconds of continuous contact before a fish is considered settled on the paper. */
  settleSeconds: 0.12,
  /** Minimum upward speed (units/s) for a lift to be a scoop attempt. */
  minLiftSpeed: 0.9,
  /**
   * A fish slides off if the poi tilts more than this (radians). Generous on
   * purpose: with the angle-based controls the poi mirrors the phone, so a
   * player aiming deep is ALWAYS tilted — 60° means only a genuinely wild
   * angle sheds the catch, not the normal control pose.
   */
  maxTiltBeforeSlide: 1.05,
  /** Slow-motion factor applied on the screen for a successful capture. */
  slowMotionScale: 0.35,
  slowMotionSeconds: 0.55,
  /** Cooldown before the same player can start another lift. */
  liftCooldownSeconds: 0.45,
};

export const GAME = {
  /** Simulation tick rate on the server. */
  tickHz: 60,
  /** Fish snapshot broadcast rate. */
  fishSnapshotHz: 30,
  /** Poi broadcast rate (kept high: this is the latency the player feels). */
  poiSnapshotHz: 60,
  /** Controller sample/send rate on the phone. */
  controllerHz: 60,

  defaultDurationSeconds: 60,
  minDurationSeconds: 60,
  maxDurationSeconds: 90,

  calibrationSeconds: 3.2,
  countdownSeconds: 3.5,
  resultSeconds: 22,

  maxPlayers: 4,
  /** Architectural ceiling — the room model supports this many (spec §11). */
  hardMaxPlayers: 8,

  /** Seconds a disconnected player is held before being removed (spec §84). */
  reconnectGraceSeconds: 3,

  defaultFishCount: 120,
  minFishCount: 10,
  maxFishCount: 200,
};

/** Screen-side interpolation buffer, in seconds. */
export const NET = {
  /** Render fish this far in the past so interpolation always has two samples. */
  fishInterpolationDelay: 0.075,
  /** Poi are rendered with light smoothing only — latency matters more than smoothness. */
  poiSmoothing: 0.045,
  /** Drop snapshots older than this. */
  snapshotBufferSeconds: 1.0,
};

/** Accent colours used to tell the four poi apart (spec §46). */
export const PLAYER_COLORS = ['#e0483a', '#3f7fd8', '#e8c33c', '#4bb264'] as const;
export const PLAYER_COLOR_NAMES = ['赤', '青', '黄', '緑'] as const;

/** Horizontal start positions so poi do not overlap at kickoff (spec §48). */
export const POI_START_X = [-4.6, -1.55, 1.55, 4.6] as const;
