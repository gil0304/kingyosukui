/**
 * Runtime kill-switches for bisecting rendering bugs at the venue, read once
 * from the page URL. Debug tooling only — nothing in the show path sets them.
 *
 *   ?fx=0      unmount the postprocessing composer (bloom etc.)
 *   ?splash=0  suppress every event-driven water visual (ripple impulses,
 *              splash/droplet/popup/glint spawns); events and audio untouched
 */
const search =
  typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;

export const DIAG = {
  noPostFx: search?.get('fx') === '0',
  noSplashFx: search?.get('splash') === '0',
  /** finer split of splash=0: suppress only the ripple-sim impulses */
  noRipple: search?.get('ripple') === '0',
  /** finer split of splash=0: suppress only the particle spawns */
  noParticles: search?.get('particles') === '0',
  /** finest split: suppress only the splash surface rings */
  noRings: search?.get('rings') === '0',
  /** finest split: suppress only the splash droplets */
  noSpray: search?.get('spray') === '0',
} as const;
