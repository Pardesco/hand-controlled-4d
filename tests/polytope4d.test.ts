import { describe, expect, it } from "vitest";
import {
  applyToVec,
  arcPoint,
  composePlaneRotations,
  identity,
  MIN_DEPTH,
  multiply,
  orthonormalityError,
  orthonormalize,
  PLANES,
  planeRotation,
  projectTo3D,
  PROJECTION_CURVES_EDGES,
  PROJECTION_EYE_W,
  type Mat4,
  type Vec4,
} from "../src/polytope4d.ts";

/** Deterministic pseudo-random stream so failures reproduce. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("plane rotations", () => {
  it("every plane rotation is orthonormal", () => {
    for (const plane of PLANES) {
      expect(orthonormalityError(planeRotation(plane, 0.7331))).toBeLessThan(1e-12);
    }
  });

  it("rotating XY by 90 degrees maps x to y and leaves z, w fixed", () => {
    const r = planeRotation("XY", Math.PI / 2);
    const v = applyToVec(r, [1, 0, 0.5, -0.25]);
    expect(v[0]).toBeCloseTo(0, 12);
    expect(v[1]).toBeCloseTo(1, 12);
    expect(v[2]).toBeCloseTo(0.5, 12);
    expect(v[3]).toBeCloseTo(-0.25, 12);
  });

  it("rotating ZW by 90 degrees maps z to w", () => {
    const r = planeRotation("ZW", Math.PI / 2);
    const v = applyToVec(r, [0.1, 0.2, 1, 0]);
    expect(v[2]).toBeCloseTo(0, 12);
    expect(v[3]).toBeCloseTo(1, 12);
  });

  it("a rotation and its inverse cancel", () => {
    const forward = planeRotation("YW", 0.4);
    const back = planeRotation("YW", -0.4);
    const product = multiply(forward, back);
    expect(orthonormalityError(product)).toBeLessThan(1e-12);
    const v = applyToVec(product, [0.3, -0.7, 0.2, 0.9]);
    expect(v[0]).toBeCloseTo(0.3, 12);
    expect(v[1]).toBeCloseTo(-0.7, 12);
    expect(v[2]).toBeCloseTo(0.2, 12);
    expect(v[3]).toBeCloseTo(0.9, 12);
  });

  it("preserves vector length (rotations are isometries)", () => {
    const rand = mulberry32(7);
    const r = identity();
    composePlaneRotations(r, { XY: 0.3, XW: -0.8, ZW: 1.7, YZ: 0.2 });
    for (let i = 0; i < 20; i += 1) {
      const v: Vec4 = [rand() - 0.5, rand() - 0.5, rand() - 0.5, rand() - 0.5];
      const rotated = applyToVec(r, v);
      expect(Math.hypot(...rotated)).toBeCloseTo(Math.hypot(...v), 10);
    }
  });
});

describe("composition and re-orthonormalisation", () => {
  it("stays orthonormal over thousands of small composed steps", () => {
    const rand = mulberry32(42);
    const r = identity();
    for (let step = 0; step < 5000; step += 1) {
      composePlaneRotations(r, {
        XY: (rand() - 0.5) * 0.05,
        XZ: (rand() - 0.5) * 0.05,
        XW: (rand() - 0.5) * 0.05,
        YZ: (rand() - 0.5) * 0.05,
        YW: (rand() - 0.5) * 0.05,
        ZW: (rand() - 0.5) * 0.05,
      });
      if (step % 60 === 59) orthonormalize(r);
    }
    orthonormalize(r);
    expect(orthonormalityError(r)).toBeLessThan(1e-10);
  });

  it("orthonormalize repairs a deliberately sheared matrix", () => {
    const m: Mat4 = identity();
    m[1] = 0.2; // shear x toward y
    m[6] = -0.1;
    orthonormalize(m);
    expect(orthonormalityError(m)).toBeLessThan(1e-12);
  });

  it("skips zero and non-finite angles", () => {
    const r = identity();
    composePlaneRotations(r, { XY: 0, XZ: Number.NaN, XW: Number.POSITIVE_INFINITY });
    expect(orthonormalityError(r)).toBeLessThan(1e-15);
    expect(r[0]).toBe(1);
  });
});

describe("4D -> 3D projection", () => {
  it("keeps the w = 0 equator at scale 1 for both modes", () => {
    for (const eyeW of Object.values(PROJECTION_EYE_W)) {
      const p = projectTo3D([0.6, -0.8, 0, 0], eyeW);
      expect(p[0]).toBeCloseTo(0.6, 12);
      expect(p[1]).toBeCloseTo(-0.8, 12);
      expect(p[2]).toBeCloseTo(0, 12);
    }
  });

  it("scales w > 0 up and w < 0 down (near side looks bigger)", () => {
    const eyeW = PROJECTION_EYE_W.perspective;
    const near = projectTo3D([0.5, 0, 0, 0.5], eyeW);
    const far = projectTo3D([0.5, 0, 0, -0.5], eyeW);
    expect(near[0]).toBeGreaterThan(0.5);
    expect(far[0]).toBeLessThan(0.5);
  });

  it("a vertex at the projection pole stays finite (clamped, no NaN)", () => {
    // Stereographic eye at 1.05; a rotated vertex can reach w = 1 exactly,
    // and pathological input might exceed it.
    for (const w of [1, 1.05, 1.2]) {
      const p = projectTo3D([0.01, 0.01, 0.01, w], PROJECTION_EYE_W.stereographic);
      for (const c of p) {
        expect(Number.isFinite(c)).toBe(true);
        expect(Math.abs(c)).toBeLessThanOrEqual(1.05 / MIN_DEPTH);
      }
    }
  });

  it("projection is monotonic in w for fixed xyz", () => {
    const eyeW = PROJECTION_EYE_W.stereographic;
    let previous = -Infinity;
    for (let w = -1; w <= 0.9; w += 0.1) {
      const p = projectTo3D([1, 0, 0, w], eyeW);
      expect(p[0]).toBeGreaterThan(previous);
      previous = p[0];
    }
  });
});

describe("great-circle edge arcs", () => {
  /** Two unit 4D points ~60 degrees apart, the 8-cell's edge separation. */
  const a: Vec4 = [0.5, 0.5, 0.5, 0.5];
  const b: Vec4 = [0.5, 0.5, 0.5, -0.5];

  it("hits the endpoints exactly", () => {
    expect(Array.from(arcPoint(a, b, 0))).toEqual(a);
    expect(Array.from(arcPoint(a, b, 1))).toEqual(b);
  });

  it("stays on the unit 3-sphere for every t", () => {
    for (let t = 0; t <= 1; t += 0.05) {
      const p = arcPoint(a, b, t);
      const norm = Math.hypot(p[0], p[1], p[2], p[3]);
      expect(norm).toBeCloseTo(1, 12);
    }
  });

  it("bulges away from the straight chord", () => {
    // The defining property: the arc midpoint sits strictly outside the chord
    // midpoint, because the chord cuts through the interior of the sphere.
    const mid = arcPoint(a, b, 0.5);
    const chord: Vec4 = [
      (a[0] + b[0]) / 2,
      (a[1] + b[1]) / 2,
      (a[2] + b[2]) / 2,
      (a[3] + b[3]) / 2,
    ];
    const chordNorm = Math.hypot(chord[0], chord[1], chord[2], chord[3]);
    expect(chordNorm).toBeLessThan(1);
    expect(Math.hypot(mid[0], mid[1], mid[2], mid[3])).toBeCloseTo(1, 12);
  });

  it("is equidistant in angle from both endpoints at t = 0.5", () => {
    const mid = arcPoint(a, b, 0.5);
    const dot = (p: Vec4, q: Vec4) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2] + p[3] * q[3];
    expect(dot(mid, a)).toBeCloseTo(dot(mid, b), 12);
  });

  it("survives antipodal endpoints instead of returning NaN", () => {
    // Not reachable from real polytope edges (they are minimum-distance pairs),
    // but the midpoint of an antipodal pair is the origin and would divide by
    // zero.
    const north: Vec4 = [0, 0, 0, 1];
    const south: Vec4 = [0, 0, 0, -1];
    const p = arcPoint(north, south, 0.5);
    for (const c of p) expect(Number.isFinite(c)).toBe(true);
  });

  it("projects to a visibly curved polyline under stereographic", () => {
    // The regression this whole feature exists for: sampling the ARC and
    // projecting must not be collinear.
    const eyeW = PROJECTION_EYE_W.stereographic;
    const p0 = projectTo3D(a, eyeW);
    const p1 = projectTo3D(arcPoint(a, b, 0.5), eyeW);
    const p2 = projectTo3D(b, eyeW);
    const sag = Math.hypot(
      p1[0] - (p0[0] + p2[0]) / 2,
      p1[1] - (p0[1] + p2[1]) / 2,
      p1[2] - (p0[2] + p2[2]) / 2
    );
    // Well above the renderer's 0.008 world-unit flatness tolerance.
    expect(sag).toBeGreaterThan(0.05);
  });

  it("sampling the straight CHORD instead would stay perfectly straight", () => {
    // Documents why subdivision alone was never going to fix this: projectTo3D
    // is a central projection, and central projections map straight lines to
    // straight lines. Interpolating in 4D WITHOUT renormalising onto the sphere
    // reproduces the same segment however finely it is sampled.
    const eyeW = PROJECTION_EYE_W.stereographic;
    const p0 = projectTo3D(a, eyeW);
    const p2 = projectTo3D(b, eyeW);
    for (const t of [0.25, 0.5, 0.75]) {
      const chord: Vec4 = [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
        a[3] + (b[3] - a[3]) * t,
      ];
      const p = projectTo3D(chord, eyeW);
      // Cross product of (p - p0) and (p2 - p0) vanishes iff the three are
      // collinear.
      const u = [p[0] - p0[0], p[1] - p0[1], p[2] - p0[2]];
      const v = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
      const cross = Math.hypot(
        u[1]! * v[2]! - u[2]! * v[1]!,
        u[2]! * v[0]! - u[0]! * v[2]!,
        u[0]! * v[1]! - u[1]! * v[0]!
      );
      expect(cross).toBeCloseTo(0, 10);
    }
  });

  it("only stereographic bows its edges", () => {
    expect(PROJECTION_CURVES_EDGES.stereographic).toBe(true);
    expect(PROJECTION_CURVES_EDGES.perspective).toBe(false);
  });
});
