/**
 * Procedural generation of the six regular polychora as vertex + edge lists.
 *
 * The build spec allows exporting JSON from the Blender polytope pipeline;
 * generating in TypeScript instead keeps the app dependency-free and lets the
 * construction itself be unit tested (vertex counts, edge counts, uniform edge
 * length, vertex degree) rather than trusted.
 *
 * Every polytope is normalised to circumradius 1, centred on the origin.
 * Edges are derived, not listed: in a regular polytope the edges are exactly
 * the vertex pairs at the minimum pairwise distance.
 */

import type { Vec4 } from "./polytope4d.ts";

export const POLYTOPE_NAMES = [
  "5-cell",
  "8-cell",
  "16-cell",
  "24-cell",
  "120-cell",
  "600-cell",
] as const;
export type PolytopeName = (typeof POLYTOPE_NAMES)[number];

export type Polytope4D = {
  name: PolytopeName;
  /** Unit circumradius, origin-centred. */
  vertices: Vec4[];
  /** Index pairs into `vertices`, i < j, each pair once. */
  edges: [number, number][];
  /** Uniform edge length after normalisation. */
  edgeLength: number;
};

/**
 * Whether this polytope only reads under stereographic projection (spec §4.2:
 * perspective turns the dense ones into an unreadable ball).
 */
export const STEREOGRAPHIC_ONLY: Record<PolytopeName, boolean> = {
  "5-cell": false,
  "8-cell": false,
  "16-cell": false,
  "24-cell": false,
  "120-cell": true,
  "600-cell": true,
};

const PHI = (1 + Math.sqrt(5)) / 2;
const SQRT5 = Math.sqrt(5);

// ------------------------------------------------------------- constructions

/** Deduplicates vectors that are equal within tolerance. */
function dedupe(points: Vec4[], tolerance = 1e-9): Vec4[] {
  const out: Vec4[] = [];
  for (const p of points) {
    let seen = false;
    for (const q of out) {
      if (
        Math.abs(p[0] - q[0]) < tolerance &&
        Math.abs(p[1] - q[1]) < tolerance &&
        Math.abs(p[2] - q[2]) < tolerance &&
        Math.abs(p[3] - q[3]) < tolerance
      ) {
        seen = true;
        break;
      }
    }
    if (!seen) out.push(p);
  }
  return out;
}

const ALL_PERMUTATIONS: number[][] = [];
const EVEN_PERMUTATIONS: number[][] = [];
{
  const permute = (rest: number[], acc: number[]): void => {
    if (rest.length === 0) {
      ALL_PERMUTATIONS.push([...acc]);
      return;
    }
    for (let i = 0; i < rest.length; i += 1) {
      permute(rest.filter((_, k) => k !== i), [...acc, rest[i]!]);
    }
  };
  permute([0, 1, 2, 3], []);
  for (const p of ALL_PERMUTATIONS) {
    let inversions = 0;
    for (let i = 0; i < 4; i += 1) {
      for (let j = i + 1; j < 4; j += 1) if (p[i]! > p[j]!) inversions += 1;
    }
    if (inversions % 2 === 0) EVEN_PERMUTATIONS.push(p);
  }
}

/** Every sign choice over the non-zero components of `base`. */
function signCombinations(base: Vec4): Vec4[] {
  let out: Vec4[] = [[...base] as Vec4];
  for (let axis = 0; axis < 4; axis += 1) {
    if (base[axis] === 0) continue;
    const next: Vec4[] = [];
    for (const v of out) {
      next.push(v);
      const flipped = [...v] as Vec4;
      flipped[axis] = -flipped[axis]!;
      next.push(flipped);
    }
    out = next;
  }
  return out;
}

function applyPermutations(vectors: Vec4[], permutations: number[][]): Vec4[] {
  const out: Vec4[] = [];
  for (const perm of permutations) {
    for (const v of vectors) {
      out.push([v[perm[0]!]!, v[perm[1]!]!, v[perm[2]!]!, v[perm[3]!]!]);
    }
  }
  return out;
}

/** All distinct permutations of `base` with all sign choices. */
function permutationsWithSigns(base: Vec4): Vec4[] {
  return dedupe(applyPermutations(signCombinations(base), ALL_PERMUTATIONS));
}

/** Even permutations only -- the icosahedral constructions require them. */
function evenPermutationsWithSigns(base: Vec4): Vec4[] {
  return dedupe(applyPermutations(signCombinations(base), EVEN_PERMUTATIONS));
}

/**
 * Regular 4-simplex: the five standard basis vectors of R^5 live in the
 * hyperplane sum = 1; subtracting their centroid gives five equidistant points
 * in a 4D subspace, expressed here in an orthonormal basis of that subspace
 * found by Gram-Schmidt. No hand-copied magic constants to get wrong.
 */
function simplex5(): Vec4[] {
  const dim = 5;
  const points: number[][] = [];
  for (let i = 0; i < dim; i += 1) {
    const p = new Array<number>(dim).fill(-1 / dim);
    p[i] = 1 - 1 / dim;
    points.push(p);
  }
  // Basis of the sum-zero subspace, orthonormalised.
  const basis: number[][] = [];
  for (let i = 0; i < dim - 1; i += 1) {
    const v = new Array<number>(dim).fill(0);
    v[i] = 1;
    v[i + 1] = -1;
    for (const b of basis) {
      let dot = 0;
      for (let k = 0; k < dim; k += 1) dot += v[k]! * b[k]!;
      for (let k = 0; k < dim; k += 1) v[k] = v[k]! - dot * b[k]!;
    }
    let norm = 0;
    for (let k = 0; k < dim; k += 1) norm += v[k]! * v[k]!;
    norm = Math.sqrt(norm);
    basis.push(v.map((x) => x / norm));
  }
  return points.map((p) => {
    const out: Vec4 = [0, 0, 0, 0];
    for (let axis = 0; axis < 4; axis += 1) {
      let dot = 0;
      for (let k = 0; k < dim; k += 1) dot += p[k]! * basis[axis]![k]!;
      out[axis] = dot;
    }
    return out;
  });
}

function rawVertices(name: PolytopeName): Vec4[] {
  switch (name) {
    case "5-cell":
      return simplex5();
    case "8-cell":
      return permutationsWithSigns([1, 1, 1, 1]);
    case "16-cell":
      return permutationsWithSigns([1, 0, 0, 0]);
    case "24-cell":
      return permutationsWithSigns([1, 1, 0, 0]);
    case "600-cell":
      return dedupe([
        ...permutationsWithSigns([0.5, 0.5, 0.5, 0.5]),
        ...permutationsWithSigns([1, 0, 0, 0]),
        ...evenPermutationsWithSigns([PHI / 2, 0.5, 1 / (2 * PHI), 0]),
      ]);
    case "120-cell":
      return dedupe([
        ...permutationsWithSigns([0, 0, 2, 2]),
        ...permutationsWithSigns([1, 1, 1, SQRT5]),
        ...permutationsWithSigns([1 / (PHI * PHI), PHI, PHI, PHI]),
        ...permutationsWithSigns([1 / PHI, 1 / PHI, 1 / PHI, PHI * PHI]),
        ...evenPermutationsWithSigns([0, 1 / (PHI * PHI), 1, PHI * PHI]),
        ...evenPermutationsWithSigns([0, 1 / PHI, PHI, SQRT5]),
        ...evenPermutationsWithSigns([1 / PHI, 1, PHI, 2]),
      ]);
  }
}

// ------------------------------------------------------------------ assembly

const cache = new Map<PolytopeName, Polytope4D>();

export function buildPolytope(name: PolytopeName): Polytope4D {
  const cached = cache.get(name);
  if (cached) return cached;

  const raw = rawVertices(name);
  const radius = Math.hypot(raw[0]![0], raw[0]![1], raw[0]![2], raw[0]![3]);
  const vertices = raw.map(
    (v): Vec4 => [v[0] / radius, v[1] / radius, v[2] / radius, v[3] / radius]
  );

  // Minimum pairwise distance = edge length, for a regular polytope.
  let min = Infinity;
  const n = vertices.length;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const a = vertices[i]!;
      const b = vertices[j]!;
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]);
      if (d < min) min = d;
    }
  }

  const limit = min * (1 + 1e-6);
  const edges: [number, number][] = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const a = vertices[i]!;
      const b = vertices[j]!;
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]);
      if (d <= limit) edges.push([i, j]);
    }
  }

  const polytope: Polytope4D = { name, vertices, edges, edgeLength: min };
  cache.set(name, polytope);
  return polytope;
}

/** Expected counts, exported so the unit tests and the GUI share one table. */
export const POLYTOPE_STATS: Record<PolytopeName, { vertices: number; edges: number }> = {
  "5-cell": { vertices: 5, edges: 10 },
  "8-cell": { vertices: 16, edges: 32 },
  "16-cell": { vertices: 8, edges: 24 },
  "24-cell": { vertices: 24, edges: 96 },
  "120-cell": { vertices: 600, edges: 1200 },
  "600-cell": { vertices: 120, edges: 720 },
};
