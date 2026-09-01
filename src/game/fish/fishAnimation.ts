/**
 * Vertex-shader swimming animation for the goldfish (spec §74).
 *
 * The whole school is drawn with a handful of 'InstancedMesh' draw calls, so
 * every fish has to be animated on the GPU. These two GLSL fragments are
 * injected into 'MeshStandardMaterial' by 'fishMaterial.ts', which keeps the
 * fish under real PBR lighting while the body, tail, pectoral fins and dorsal
 * fin all move independently.
 *
 * What the deformation does, per instance:
 *   - body: a lateral (local Z) sine travelling wave along 'aSpine', amplitude
 *     growing toward the tail, frequency scaled by the instance's speed;
 *   - caudal fin: the same wave with a bigger amplitude, a phase lag and a fan
 *     spread that opens the lobes at the extremes of the sweep;
 *   - pectoral fins: a rigid flapping rotation about the body axis, half a beat
 *     out of phase left vs right, and much faster while escaping;
 *   - dorsal / anal fin: a small trailing sway that lags the body;
 *   - eyes: rigid — they ride the head and are never sheared;
 *   - a body arch driven by the instanced 'aTurn' attribute, so a banking fish
 *     visibly bends into the turn.
 *
 * The normal is rotated by the analytic derivative of the wave (never left
 * unrotated), so a fish beating its tail hard still lights correctly.
 *
 * This module is deliberately free of 'three' imports: it is only strings and
 * numbers, so it can be unit tested and reused by any renderer.
 */

import { clamp01 } from '@/game/core/math';
import type { FishAnimState } from '@/types';

/**
 * Attribute / uniform / varying declarations, prepended to the standard vertex
 * shader.
 *
 * 'aSpeed' is packed: '.x' is the tail-beat frequency in cycles per second
 * ('animSpeedFor') and '.y' is the amplitude multiplier ('animAmplitudeFor').
 */
export const FISH_VERTEX_HEAD = /* glsl */ `
attribute float aPart;      // 0 body, 1 caudal, 2 pectoral, 3 dorsal/anal, 4 eye
attribute float aSpine;     // 0 at the nose, 1 at the tip of the tail
attribute float aSide;      // -1 / 0 / +1 : which pectoral fin

attribute float aPhase;     // per-instance beat offset, in turns
attribute vec2  aSpeed;     // x = beats per second, y = amplitude multiplier
attribute float aState;     // FishAnimState index
attribute float aTurn;      // -1..1 banking / turning amount
attribute vec3  aTint;      // per-instance colour jitter
attribute float aSheen;     // per-instance specular sheen

uniform float uTime;
uniform float uLength;      // nose-to-tail length, world units
uniform float uInvDepth;    // 1 / body half-height
uniform float uWaveNumber;  // radians of wave phase across the whole body
uniform float uBodyAmp;
uniform float uTailAmp;
uniform float uTailLag;
uniform float uTailBase;    // aSpine where the caudal fin starts
uniform float uTailSpread;
uniform float uFinAmp;
uniform float uFlapAmp;
uniform float uArchAmp;
uniform float uFinPivotY;   // Y of the pectoral fin root

varying float vPart;
varying float vSpine;
varying float vBelly;
varying float vSide;
varying float vBeat;
varying vec3  vTint;
varying float vSheen;
`;

/**
 * The deformation itself. Runs where 'transformed' and 'objectNormal' are both
 * in scope, and rewrites both.
 */
export const FISH_VERTEX_BODY = /* glsl */ `
{
	float fSpine = aSpine;
	float fPart  = aPart;
	float fBeat  = ( uTime * aSpeed.x + aPhase ) * 6.283185307;
	float fAmp   = aSpeed.y;

	float isTail = step( 0.5, fPart ) * step( fPart, 1.5 );
	float isPec  = step( 1.5, fPart ) * step( fPart, 2.5 );
	float isVFin = step( 2.5, fPart ) * step( fPart, 3.5 );
	float isEye  = step( 3.5, fPart );

	// FishAnimState: 0 IdleSwim, 1 FastSwim, 2 Escape, 3 Captured, 4 Drop, 5 BowlSwim.
	float isEscape = step( 1.5, aState ) * step( aState, 2.5 );
	float isOut    = step( 2.5, aState ) * step( aState, 4.5 );

	// --- pectoral fins: a rigid rotation about the body axis ----------------
	// Rigid, so the same rotation applies to the normal and nothing shears.
	float flapRate = ( 0.9 + 0.5 * fAmp ) * ( 1.0 + 1.4 * isEscape + 1.1 * isOut );
	float flapAng  = isPec * uFlapAmp * ( 0.65 + 0.6 * fAmp ) * ( 1.0 + 0.55 * isEscape )
		* sin( fBeat * flapRate + ( 1.0 - aSide ) * 1.570796327 );
	float fc = cos( flapAng );
	float fs = sin( flapAng );
	float pry = transformed.y - uFinPivotY;
	float prz = transformed.z;
	transformed.y = uFinPivotY + pry * fc - prz * fs;
	transformed.z = pry * fs + prz * fc;
	float pny = objectNormal.y;
	float pnz = objectNormal.z;
	objectNormal.y = pny * fc - pnz * fs;
	objectNormal.z = pny * fs + pnz * fc;

	// --- body: lateral travelling wave along the spine ----------------------
	float fK  = uWaveNumber;
	float fE  = clamp( ( fSpine - 0.08 ) / 0.92, 0.0, 1.0 );
	float env  = fE * fE * ( 0.35 + 0.65 * fE );
	float dEnv = ( 2.0 * fE * ( 0.35 + 0.65 * fE ) + 0.65 * fE * fE ) / 0.92;

	float ph = fBeat - fSpine * fK;
	float sw = sin( ph );
	float cw = cos( ph );

	float fA  = uBodyAmp * fAmp * uLength;
	float fD  = fA * env * sw;                          // lateral offset
	float fDs = fA * ( dEnv * sw - env * fK * cw );     // d/d(aSpine)
	float fDy = 0.0;                                    // d/dy

	// --- caudal fin: bigger amplitude, phase lag, fanning lobes -------------
	float tSpan = max( 1.0 - uTailBase, 0.001 );
	float tR  = clamp( ( fSpine - uTailBase ) / tSpan, 0.0, 1.0 );
	float tRR = tR * tR;
	float tph = ph - uTailLag;
	float tsw = sin( tph );
	float tcw = cos( tph );
	float fT  = uTailAmp * fAmp * uLength * isTail;
	fD  += fT * tRR * tsw;
	fDs += fT * ( ( 2.0 * tR / tSpan ) * tsw - tRR * fK * tcw );

	// --- dorsal / anal: a small trailing sway that grows with fin height ----
	float finH = clamp( abs( transformed.y ) * uInvDepth, 0.0, 1.5 ) * isVFin;
	float fph  = ph - 1.15;
	float fF   = uFinAmp * fAmp * uLength;
	fD  += fF * finH * sin( fph );
	fDs += fF * finH * ( -fK ) * cos( fph );
	fDy += fF * sign( transformed.y ) * uInvDepth * isVFin * sin( fph );

	// --- body arch while turning (spec §74) ---------------------------------
	float a1   = 1.0 - fSpine;
	float arch = uArchAmp * aTurn * uLength;
	fD  += arch * ( fSpine * fSpine - 0.18 * a1 * a1 );
	fDs += arch * ( 2.0 * fSpine + 0.36 * a1 );

	transformed.z += fD;

	// Caudal lobes open as the tail reaches the end of its sweep.
	float spread = isTail * uTailSpread * tRR * abs( tsw );
	transformed.y += transformed.y * spread;
	objectNormal.y /= ( 1.0 + spread );

	// Analytic normal: the wave is a shear p' = p + D( x, y ) * z^, whose
	// inverse-transpose reduces to n' = n - ( dD/dx, dD/dy, 0 ) * n.z.
	// aSpine decreases as x increases, hence the sign on dD/dx.
	float rigid = 1.0 - isEye;
	float dDdx  = -fDs / max( uLength, 0.0001 );
	objectNormal.x -= rigid * dDdx * objectNormal.z;
	objectNormal.y -= rigid * fDy * objectNormal.z;
	objectNormal = normalize( objectNormal );

	vPart  = fPart;
	vSpine = fSpine;
	vSide  = aSide;
	vBeat  = sw;
	vBelly = clamp( position.y * uInvDepth * 0.9 + 0.5, 0.0, 1.0 );
	vTint  = aTint;
	vSheen = aSheen;
}
`;

/** Default shader tuning; 'fishMaterial.ts' layers per-species values on top. */
export const FISH_ANIM_TUNING = {
  /** Radians of wave phase between the nose and the tail tip. */
  waveNumber: 4.6,
  /**
   * Body wave amplitude, as a fraction of body length. Tuned with 'tailAmp' so
   * a cruising fish sweeps its tail through roughly ±26° and a fleeing one
   * through ±37° — clearly readable from the back of the room.
   */
  bodyAmp: 0.07,
  /** Caudal fin amplitude, as a fraction of body length. */
  tailAmp: 0.17,
  /** Extra phase lag of the caudal fin behind the body wave, radians. */
  tailLag: 0.85,
  /** How far the caudal lobes fan open at the extremes of the sweep. */
  tailSpread: 0.16,
  /** Dorsal / anal trailing sway, as a fraction of body length. */
  finAmp: 0.03,
  /** Peak pectoral flap angle, radians. */
  flapAmp: 0.62,
  /** Body arch at full turn, as a fraction of body length. */
  archAmp: 0.075,
} as const;

/**
 * Tail-beat frequency in cycles per second for an animation state.
 *
 * A captured fish thrashes: the audience must be able to read "this one is
 * caught" from across the room without a caption (spec §80).
 */
export function animSpeedFor(state: FishAnimState, speed01: number): number {
  const s = clamp01(speed01);
  switch (state) {
    case 'FastSwim':
      return 2.0 + s * 2.4;
    case 'Escape':
      return 3.2 + s * 3.4;
    case 'Captured':
      return 4.2 + s * 1.0;
    case 'Drop':
      return 3.4 + s * 1.2;
    case 'BowlSwim':
      return 1.0 + s * 1.3;
    case 'IdleSwim':
    default:
      return 1.1 + s * 1.5;
  }
}

/** Wave amplitude multiplier for an animation state. */
export function animAmplitudeFor(state: FishAnimState, speed01: number): number {
  const s = clamp01(speed01);
  switch (state) {
    case 'FastSwim':
      return 0.85 + s * 0.35;
    case 'Escape':
      return 1.15 + s * 0.45;
    case 'Captured':
      return 1.45;
    case 'Drop':
      return 1.25;
    case 'BowlSwim':
      return 0.6 + s * 0.3;
    case 'IdleSwim':
    default:
      return 0.55 + s * 0.35;
  }
}
