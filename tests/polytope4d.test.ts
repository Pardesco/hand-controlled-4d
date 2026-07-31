import { describe, expect, it } from "vitest";
import {
  applyToVec,
  composePlaneRotations,
  identity,
  MIN_DEPTH,
  multiply,
  orthonormalityError,
  orthonormalize,
  PLANES,
  planeRotation,
  projectTo3D,
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
