/**
 * Hand occlusion geometry: convex hull of the 21 landmarks, expanded by a
 * margin, plus a depth estimate from palm span. Pure maths, no DOM or three.js
 * -- the renderer turns the result into a depth-only mesh.
 *
 * Depth from apparent size (spec §3): palm span is proportional to 1/distance
 * from the lens, so `referenceSpan / span` gives distance in units of "where
 * the polytope sits". Reaching toward the camera grows the span and pulls the
 * hand mask in front of the geometry; pulling back lets edges pass in front of
 * the hand. That responsiveness is what makes the object read as being in the
 * room.
 */

import type { Point2D } from "./types.ts";

/**
 * Convex hull (Andrew's monotone chain), counter-clockwise in a y-down screen
 * space. Duplicates are collapsed; degenerate inputs return what they can
 * (0, 1 or 2 points).
 */
export function convexHull(points: readonly Point2D[]): Point2D[] {
  const sorted = [...points]
    .sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x))
    .filter((p, i, arr) => i === 0 || p.x !== arr[i - 1]!.x || p.y !== arr[i - 1]!.y);
  if (sorted.length <= 2) return sorted;

  const cross = (o: Point2D, a: Point2D, b: Point2D): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Point2D[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Point2D[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const p = sorted[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Pushes every hull vertex outward from the hull centroid by `margin`.
 * Hands are thicker than their landmark skeleton (spec §3): without a margin
 * the polytope clips into the flesh of the palm edge.
 *
 * Radial expansion (not true polygon offsetting) is deliberate: it is
 * allocation-light, cannot self-intersect, and the visual difference at a
 * 2-4% margin is nil.
 */
export function expandHull(hull: readonly Point2D[], margin: number): Point2D[] {
  if (hull.length === 0 || margin === 0) return [...hull];
  let cx = 0;
  let cy = 0;
  for (const p of hull) {
    cx += p.x;
    cy += p.y;
  }
  cx /= hull.length;
  cy /= hull.length;
  return hull.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return { x: p.x, y: p.y };
    const scale = (len + margin) / len;
    return { x: cx + dx * scale, y: cy + dy * scale };
  });
}

export type DepthOptions = {
  /**
   * Palm span (video-normalized) measured with the hand at the polytope's
   * distance. Spans larger than this place the hand in front of the object.
   */
  referenceSpan: number;
  /** Nearest allowed depth, as a fraction of the object distance. */
  minDepthFactor: number;
  /** Farthest allowed depth, likewise. */
  maxDepthFactor: number;
};

export const DEFAULT_DEPTH_OPTIONS: DepthOptions = {
  referenceSpan: 0.11,
  minDepthFactor: 0.25,
  maxDepthFactor: 4,
};

/**
 * Estimated distance from the camera, in units of the polytope's distance:
 * 1.0 means "exactly at the object", smaller is nearer the lens.
 * Inverse-proportional in span, clamped at both ends so a landmark glitch
 * cannot fling the mask behind the camera or to infinity.
 */
export function depthFromSpan(span: number, options: DepthOptions = DEFAULT_DEPTH_OPTIONS): number {
  const { referenceSpan, minDepthFactor, maxDepthFactor } = options;
  if (!Number.isFinite(span) || span <= 1e-6) return maxDepthFactor;
  const depth = referenceSpan / span;
  return Math.min(maxDepthFactor, Math.max(minDepthFactor, depth));
}

/** One hand's occlusion geometry, display space + relative depth. */
export type HandMask = {
  hull: Point2D[];
  /** 1.0 = at the polytope, < 1 in front of it, > 1 behind it. */
  depth: number;
};

export function buildHandMask(
  landmarksDisplay: readonly Point2D[],
  span: number,
  margin: number,
  depthOptions: DepthOptions = DEFAULT_DEPTH_OPTIONS
): HandMask | null {
  if (landmarksDisplay.length < 3) return null;
  const hull = expandHull(convexHull(landmarksDisplay), margin);
  if (hull.length < 3) return null;
  return { hull, depth: depthFromSpan(span, depthOptions) };
}
