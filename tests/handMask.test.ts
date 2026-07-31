import { describe, expect, it } from "vitest";
import {
  buildHandMask,
  convexHull,
  DEFAULT_DEPTH_OPTIONS,
  depthFromSpan,
  expandHull,
} from "../src/handMask.ts";
import type { Point2D } from "../src/types.ts";

/** Signed area via the shoelace formula; > 0 for CCW in y-down space is negative -- we only use |area|. */
function polygonArea(points: readonly Point2D[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

function pointInConvexPolygon(p: Point2D, hull: readonly Point2D[]): boolean {
  let sign = 0;
  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(cross) < 1e-12) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

describe("convexHull", () => {
  it("finds the square around interior points", () => {
    const points: Point2D[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
      { x: 0.5, y: 0.5 },
      { x: 0.25, y: 0.75 },
    ];
    const hull = convexHull(points);
    expect(hull).toHaveLength(4);
    expect(polygonArea(hull)).toBeCloseTo(1, 12);
  });

  it("drops collinear points on an edge", () => {
    const hull = convexHull([
      { x: 0, y: 0 },
      { x: 0.5, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]);
    expect(hull).toHaveLength(4);
  });

  it("handles duplicates and degenerate input", () => {
    expect(convexHull([])).toHaveLength(0);
    expect(convexHull([{ x: 0.5, y: 0.5 }])).toHaveLength(1);
    expect(
      convexHull([
        { x: 0.5, y: 0.5 },
        { x: 0.5, y: 0.5 },
        { x: 0.5, y: 0.5 },
      ])
    ).toHaveLength(1);
  });

  it("contains every input point", () => {
    // Deterministic scatter.
    const points: Point2D[] = [];
    for (let i = 0; i < 21; i += 1) {
      points.push({
        x: 0.5 + 0.3 * Math.sin(i * 2.399),
        y: 0.5 + 0.3 * Math.cos(i * 1.117),
      });
    }
    const hull = convexHull(points);
    expect(hull.length).toBeGreaterThanOrEqual(3);
    for (const p of points) {
      expect(pointInConvexPolygon(p, hull)).toBe(true);
    }
  });
});

describe("expandHull", () => {
  it("grows the polygon outward by the margin", () => {
    const square: Point2D[] = [
      { x: 0.4, y: 0.4 },
      { x: 0.6, y: 0.4 },
      { x: 0.6, y: 0.6 },
      { x: 0.4, y: 0.6 },
    ];
    const expanded = expandHull(square, 0.05);
    expect(polygonArea(expanded)).toBeGreaterThan(polygonArea(square));
    // Original polygon is strictly inside the expanded one.
    for (const p of square) expect(pointInConvexPolygon(p, expanded)).toBe(true);
  });

  it("zero margin is the identity", () => {
    const tri: Point2D[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ];
    expect(expandHull(tri, 0)).toEqual(tri);
  });
});

describe("depthFromSpan", () => {
  it("is monotonically decreasing in span (bigger hand = nearer)", () => {
    let previous = Infinity;
    for (const span of [0.05, 0.08, 0.11, 0.15, 0.2, 0.3]) {
      const depth = depthFromSpan(span);
      expect(depth).toBeLessThanOrEqual(previous);
      previous = depth;
    }
  });

  it("reads 1.0 at the reference span (hand at the object)", () => {
    expect(depthFromSpan(DEFAULT_DEPTH_OPTIONS.referenceSpan)).toBeCloseTo(1, 12);
  });

  it("clamps both ends and survives junk input", () => {
    expect(depthFromSpan(1e9)).toBe(DEFAULT_DEPTH_OPTIONS.minDepthFactor);
    expect(depthFromSpan(1e-9)).toBe(DEFAULT_DEPTH_OPTIONS.maxDepthFactor);
    expect(depthFromSpan(0)).toBe(DEFAULT_DEPTH_OPTIONS.maxDepthFactor);
    expect(depthFromSpan(Number.NaN)).toBe(DEFAULT_DEPTH_OPTIONS.maxDepthFactor);
  });
});

describe("buildHandMask", () => {
  it("returns hull + depth for a plausible hand", () => {
    const landmarks: Point2D[] = [];
    for (let i = 0; i < 21; i += 1) {
      landmarks.push({
        x: 0.5 + 0.08 * Math.sin(i * 1.7),
        y: 0.6 + 0.1 * Math.cos(i * 2.3),
      });
    }
    const mask = buildHandMask(landmarks, 0.11, 0.02);
    expect(mask).not.toBeNull();
    expect(mask!.hull.length).toBeGreaterThanOrEqual(3);
    expect(mask!.depth).toBeCloseTo(1, 6);
  });

  it("returns null for degenerate landmark sets", () => {
    expect(buildHandMask([], 0.1, 0.02)).toBeNull();
    expect(buildHandMask([{ x: 0.5, y: 0.5 }], 0.1, 0.02)).toBeNull();
    const collapsed = new Array(21).fill({ x: 0.5, y: 0.5 });
    expect(buildHandMask(collapsed, 0.1, 0.02)).toBeNull();
  });
});
