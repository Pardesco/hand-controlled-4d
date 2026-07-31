import { describe, expect, it } from "vitest";
import {
  buildPolytope,
  POLYTOPE_NAMES,
  POLYTOPE_STATS,
  type PolytopeName,
} from "../src/polychora.ts";

/** Edge count per vertex for each regular polychoron (known values). */
const VERTEX_DEGREE: Record<PolytopeName, number> = {
  "5-cell": 4,
  "8-cell": 4,
  "16-cell": 6,
  "24-cell": 8,
  "120-cell": 4,
  "600-cell": 12,
};

describe.each(POLYTOPE_NAMES)("%s", (name) => {
  const polytope = buildPolytope(name);
  const stats = POLYTOPE_STATS[name];

  it("has the documented vertex and edge counts", () => {
    expect(polytope.vertices.length).toBe(stats.vertices);
    expect(polytope.edges.length).toBe(stats.edges);
  });

  it("is normalised to unit circumradius", () => {
    for (const v of polytope.vertices) {
      expect(Math.hypot(...v)).toBeCloseTo(1, 9);
    }
  });

  it("is origin-centred", () => {
    const centroid = [0, 0, 0, 0];
    for (const v of polytope.vertices) {
      for (let k = 0; k < 4; k += 1) centroid[k] = centroid[k]! + v[k]! / polytope.vertices.length;
    }
    for (const c of centroid) expect(Math.abs(c)).toBeLessThan(1e-9);
  });

  it("has uniform edge length", () => {
    for (const [i, j] of polytope.edges) {
      const a = polytope.vertices[i]!;
      const b = polytope.vertices[j]!;
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]);
      expect(d).toBeCloseTo(polytope.edgeLength, 9);
    }
  });

  it("is vertex-transitive in degree", () => {
    const degree = new Array<number>(polytope.vertices.length).fill(0);
    for (const [i, j] of polytope.edges) {
      degree[i] = degree[i]! + 1;
      degree[j] = degree[j]! + 1;
    }
    for (const d of degree) expect(d).toBe(VERTEX_DEGREE[name]);
  });

  it("lists each edge once with i < j", () => {
    const seen = new Set<string>();
    for (const [i, j] of polytope.edges) {
      expect(i).toBeLessThan(j);
      const key = `${i}-${j}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

it("caches builds (same object back)", () => {
  expect(buildPolytope("8-cell")).toBe(buildPolytope("8-cell"));
});
