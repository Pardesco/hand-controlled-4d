/**
 * THE single place where camera space and screen space are reconciled.
 *
 * ------------------------------------------------------------------
 * Coordinate contract (read this before touching anything spatial)
 * ------------------------------------------------------------------
 *
 * VIDEO space   normalized 0..1 over the *raw* camera frame.
 *               origin upper-left, x right, y down.
 *               MediaPipe landmarks arrive in this space; hand tracking,
 *               assignment and smoothing all stay in it.
 *
 * DISPLAY space normalized 0..1 over the *rendered canvas*.
 *               origin upper-left, x right, y down.
 *               Portal geometry, the debug overlay and the fragment shader
 *               all work in this space.
 *
 * The two differ by (a) a cover-crop that preserves the camera aspect ratio
 * while filling the canvas, and (b) an optional horizontal mirror.
 *
 * Mirroring design decision: MediaPipe is given the *raw, unmirrored* video
 * (no extra canvas copy per frame, no duplicate upload). The mirror is applied
 * once, here, in `videoToDisplay` / `displayToVideo`, and once more in the
 * fragment shader using the very same uniforms produced by
 * `cropTransformToUniform()`. There is no `1.0 - x` anywhere else in the
 * codebase.
 *
 * The shader consumes the *inverse* map (display -> video) because it walks
 * screen pixels; the CPU consumes the forward map (video -> display) because
 * it walks landmarks. Both are defined below and are exact inverses.
 */

import type { Point2D } from "./types.ts";

export type CropTransform = {
  /** Fraction of the raw frame width that survives the cover-crop (0..1]. */
  fracX: number;
  /** Fraction of the raw frame height that survives the cover-crop (0..1]. */
  fracY: number;
  /** Left edge of the visible window, in video-normalized units. */
  offsetX: number;
  /** Top edge of the visible window, in video-normalized units. */
  offsetY: number;
  /** Whether the display is horizontally mirrored (selfie view). */
  mirrored: boolean;
};

export const IDENTITY_CROP: CropTransform = {
  fracX: 1,
  fracY: 1,
  offsetX: 0,
  offsetY: 0,
  mirrored: false,
};

/**
 * Cover-fit: scale the camera frame up until it covers the canvas, then centre-crop
 * the overflow. Aspect ratio is never distorted.
 */
export function computeCropTransform(
  videoWidth: number,
  videoHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  mirrored: boolean
): CropTransform {
  if (
    !Number.isFinite(videoWidth) ||
    !Number.isFinite(videoHeight) ||
    !Number.isFinite(canvasWidth) ||
    !Number.isFinite(canvasHeight) ||
    videoWidth <= 0 ||
    videoHeight <= 0 ||
    canvasWidth <= 0 ||
    canvasHeight <= 0
  ) {
    return { ...IDENTITY_CROP, mirrored };
  }

  const videoAspect = videoWidth / videoHeight;
  const canvasAspect = canvasWidth / canvasHeight;

  let fracX = 1;
  let fracY = 1;
  if (videoAspect > canvasAspect) {
    // Camera is wider than the canvas -> crop left/right.
    fracX = canvasAspect / videoAspect;
  } else if (videoAspect < canvasAspect) {
    // Camera is taller than the canvas -> crop top/bottom.
    fracY = videoAspect / canvasAspect;
  }

  return {
    fracX,
    fracY,
    offsetX: (1 - fracX) * 0.5,
    offsetY: (1 - fracY) * 0.5,
    mirrored,
  };
}

/** Video-normalized -> display-normalized. Used for landmarks. */
export function videoToDisplay(p: Point2D, t: CropTransform): Point2D {
  const x = (p.x - t.offsetX) / t.fracX;
  const y = (p.y - t.offsetY) / t.fracY;
  return { x: t.mirrored ? 1 - x : x, y };
}

/** Display-normalized -> video-normalized. Mirrors the shader's sampling path. */
export function displayToVideo(p: Point2D, t: CropTransform): Point2D {
  const x = t.mirrored ? 1 - p.x : p.x;
  return {
    x: x * t.fracX + t.offsetX,
    y: p.y * t.fracY + t.offsetY,
  };
}

/**
 * Packs the transform for the shader as `vec4(fracX, fracY, offsetX, offsetY)`.
 * `mirrored` travels separately as a float uniform.
 */
export function cropTransformToUniform(t: CropTransform): [number, number, number, number] {
  return [t.fracX, t.fracY, t.offsetX, t.offsetY];
}

/**
 * Euclidean distance between two display-normalized points, corrected for the
 * canvas aspect ratio so the result is in *pixels* rather than in the anisotropic
 * normalized units. Required for anything radial: rounded corners, feather widths,
 * rotation angles.
 */
export function aspectDistance(
  a: Point2D,
  b: Point2D,
  renderWidth: number,
  renderHeight: number
): number {
  const dx = (a.x - b.x) * renderWidth;
  const dy = (a.y - b.y) * renderHeight;
  return Math.hypot(dx, dy);
}

/** Angle of the a->b vector in radians, aspect-corrected (0 = screen right). */
export function aspectAngle(
  a: Point2D,
  b: Point2D,
  renderWidth: number,
  renderHeight: number
): number {
  return Math.atan2((b.y - a.y) * renderHeight, (b.x - a.x) * renderWidth);
}
