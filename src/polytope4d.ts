/**
 * 4D rotation and projection. Pure maths, no DOM, unit tested.
 *
 * Orientation is a 4x4 rotation matrix in SO(4), stored row-major in a
 * Float64Array(16). Double precision matters: the matrix accumulates thousands
 * of small compositions per minute, and float32 shear becomes visible on screen
 * well before it would in a one-shot transform.
 */

export type Vec4 = [number, number, number, number];
export type Vec3 = [number, number, number];
export type Mat4 = Float64Array;

/** The six independent rotation planes of SO(4), in a fixed public order. */
export const PLANES = ["XY", "XZ", "XW", "YZ", "YW", "ZW"] as const;
export type RotationPlane = (typeof PLANES)[number];

/** Per-plane rotation rates or angles, radians (per second or absolute). */
export type PlaneAngles = Record<RotationPlane, number>;

export const ZERO_ANGLES: Readonly<PlaneAngles> = Object.freeze({
  XY: 0,
  XZ: 0,
  XW: 0,
  YZ: 0,
  YW: 0,
  ZW: 0,
});

/** Axis index pair for each plane: the two coordinates the rotation mixes. */
const PLANE_AXES: Record<RotationPlane, [number, number]> = {
  XY: [0, 1],
  XZ: [0, 2],
  XW: [0, 3],
  YZ: [1, 2],
  YW: [1, 3],
  ZW: [2, 3],
};

export function identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** Rotation by `angle` in one coordinate plane, all other axes fixed. */
export function planeRotation(plane: RotationPlane, angle: number): Mat4 {
  const m = identity();
  const [a, b] = PLANE_AXES[plane];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  m[a * 4 + a] = c;
  m[a * 4 + b] = -s;
  m[b * 4 + a] = s;
  m[b * 4 + b] = c;
  return m;
}

/** out = a * b. `out` may not alias `a` or `b`. */
export function multiply(a: Mat4, b: Mat4, out: Mat4 = new Float64Array(16)): Mat4 {
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += a[row * 4 + k]! * b[k * 4 + col]!;
      }
      out[row * 4 + col] = sum;
    }
  }
  return out;
}

export function applyToVec(m: Mat4, v: Readonly<Vec4>, out: Vec4 = [0, 0, 0, 0]): Vec4 {
  const [x, y, z, w] = v;
  out[0] = m[0]! * x + m[1]! * y + m[2]! * z + m[3]! * w;
  out[1] = m[4]! * x + m[5]! * y + m[6]! * z + m[7]! * w;
  out[2] = m[8]! * x + m[9]! * y + m[10]! * z + m[11]! * w;
  out[3] = m[12]! * x + m[13]! * y + m[14]! * z + m[15]! * w;
  return out;
}

/**
 * Composes this frame's six plane increments onto an accumulated orientation:
 *
 *     R = rot(ZW) · rot(YW) · rot(YZ) · rot(XW) · rot(XZ) · rot(XY) · R
 *
 * Zero angles are skipped, so the common one-or-two-plane frame costs one or
 * two matrix multiplies. Order within a single frame is irrelevant at gesture
 * rates: the angles are ~1e-2 rad and the commutator error is O(angle²).
 */
export function composePlaneRotations(
  r: Mat4,
  angles: Readonly<Partial<PlaneAngles>>,
  scratch: Mat4 = new Float64Array(16)
): Mat4 {
  for (const plane of PLANES) {
    const angle = angles[plane];
    if (!angle || !Number.isFinite(angle)) continue;
    multiply(planeRotation(plane, angle), r, scratch);
    r.set(scratch);
  }
  return r;
}

/**
 * Gram-Schmidt re-orthonormalisation of the matrix rows, in place.
 * Accumulated float error otherwise shears the polytope visibly within a
 * minute of continuous rotation.
 */
export function orthonormalize(m: Mat4): Mat4 {
  for (let row = 0; row < 4; row += 1) {
    // Subtract projections onto all previous rows.
    for (let prev = 0; prev < row; prev += 1) {
      let dot = 0;
      for (let k = 0; k < 4; k += 1) dot += m[row * 4 + k]! * m[prev * 4 + k]!;
      for (let k = 0; k < 4; k += 1) m[row * 4 + k] = m[row * 4 + k]! - dot * m[prev * 4 + k]!;
    }
    let norm = 0;
    for (let k = 0; k < 4; k += 1) norm += m[row * 4 + k]! * m[row * 4 + k]!;
    norm = Math.sqrt(norm);
    if (norm < 1e-12) {
      // Degenerate row (should be unreachable for a near-rotation): reset to
      // the identity's row so the matrix stays invertible instead of NaN.
      for (let k = 0; k < 4; k += 1) m[row * 4 + k] = k === row ? 1 : 0;
      continue;
    }
    for (let k = 0; k < 4; k += 1) m[row * 4 + k] = m[row * 4 + k]! / norm;
  }
  return m;
}

/** Largest deviation of M·Mᵀ from the identity: 0 for a perfect rotation. */
export function orthonormalityError(m: Mat4): number {
  let worst = 0;
  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < 4; j += 1) {
      let dot = 0;
      for (let k = 0; k < 4; k += 1) dot += m[i * 4 + k]! * m[j * 4 + k]!;
      worst = Math.max(worst, Math.abs(dot - (i === j ? 1 : 0)));
    }
  }
  return worst;
}

export type ProjectionMode = "perspective" | "stereographic";

/**
 * 4D -> 3D projection from an eye on the +W axis at distance `eyeW` from the
 * origin, for geometry normalised to circumradius 1.
 *
 * `perspective`   eyeW well outside the unit sphere (~2.2). Reads like a 3D
 *                 object with a smaller object inside -- right for the sparse
 *                 polychora.
 * `stereographic` eyeW just above 1: the eye sits (almost) on the sphere the
 *                 vertices live on. Cells become finite curved regions instead
 *                 of collapsing toward the centre -- the only readable choice
 *                 for the 120-cell and 600-cell.
 *
 * The denominator is clamped so a vertex rotating through the eye point
 * produces a large-but-finite spike rather than NaN/Infinity. With
 * stereographic eyeW = 1.05 the worst-case scale is 1.05/0.05 = 21, i.e. the
 * geometry stays within ~21 units of the origin and never explodes.
 */
export const MIN_DEPTH = 0.05;

export function projectTo3D(v: Readonly<Vec4>, eyeW: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const depth = Math.max(eyeW - v[3], MIN_DEPTH);
  // Numerator eyeW pins the w = 0 equator at scale 1 for every eye distance,
  // so switching projection modes never changes the apparent size wholesale.
  const scale = eyeW / depth;
  out[0] = v[0] * scale;
  out[1] = v[1] * scale;
  out[2] = v[2] * scale;
  return out;
}

export const PROJECTION_EYE_W: Record<ProjectionMode, number> = {
  perspective: 2.2,
  stereographic: 1.05,
};

/**
 * Whether edges of this projection are drawn as great-circle arcs rather than
 * straight chords.
 *
 * This is the whole reason stereographic looks different, and it is easy to get
 * wrong. `projectTo3D` is a CENTRAL projection, and central projections are
 * projective maps: they send straight lines to straight lines. So sampling
 * along a straight 4D chord and projecting each sample reproduces the same
 * straight segment no matter how finely you subdivide it -- subdivision alone
 * buys nothing.
 *
 * Curvature comes from changing the CURVE, not the sampling: an edge of a
 * polytope inscribed in the 3-sphere is drawn as the geodesic between its
 * endpoints, i.e. the great-circle arc lying ON the sphere, which bulges away
 * from the chord through the interior. Stereographic projection is conformal
 * and circle-preserving, so that arc lands as a circular arc in 3-space -- the
 * signature curved edges. Perspective is left straight to match the main
 * viewer, whose `generateCurvePoints` also returns bare endpoints for it.
 */
export const PROJECTION_CURVES_EDGES: Record<ProjectionMode, boolean> = {
  perspective: false,
  stereographic: true,
};

/**
 * Point at parameter `t` along the great-circle arc from `a` to `b`, for points
 * on the unit 3-sphere (which every vertex is -- polychora.ts normalises to
 * circumradius 1).
 *
 * Normalised linear interpolation, not slerp: it traces exactly the same arc,
 * just with a non-uniform speed along it. That is fine here because the samples
 * only need to sit on the arc, and it costs one square root instead of two
 * trigonometric calls per sample on a path that runs thousands of times a
 * frame. It is also precisely what the main viewer does, so the two apps bow
 * their edges identically.
 *
 * Degenerate only for antipodal endpoints, where the great circle is not
 * unique and the midpoint collapses to the origin; polytope edges are
 * minimum-distance vertex pairs, so that cannot arise, but it falls back to `a`
 * rather than returning NaN.
 */
export function arcPoint(
  a: Readonly<Vec4>,
  b: Readonly<Vec4>,
  t: number,
  out: Vec4 = [0, 0, 0, 0]
): Vec4 {
  const x = a[0] + (b[0] - a[0]) * t;
  const y = a[1] + (b[1] - a[1]) * t;
  const z = a[2] + (b[2] - a[2]) * t;
  const w = a[3] + (b[3] - a[3]) * t;
  const norm = Math.sqrt(x * x + y * y + z * z + w * w);
  if (norm < 1e-12) {
    out[0] = a[0];
    out[1] = a[1];
    out[2] = a[2];
    out[3] = a[3];
    return out;
  }
  const inv = 1 / norm;
  out[0] = x * inv;
  out[1] = y * inv;
  out[2] = z * inv;
  out[3] = w * inv;
  return out;
}
