/** Shared data model. All 2D points are normalized (0..1) unless stated otherwise. */

/** Build version, injected by Vite from package.json. */
declare global {
  const __APP_VERSION__: string;
}

export type Point2D = {
  x: number;
  y: number;
};

export type Handedness = "Left" | "Right";

/**
 * One hand, in *video-normalized* coordinates: origin at the upper-left of the
 * raw camera frame, x to the right, y down. This is MediaPipe's own convention
 * and it is preserved everywhere in tracking/geometry code. Conversion to
 * display space happens in exactly one place -- `src/coords.ts`.
 */
export type TrackedHand = {
  handedness: Handedness;
  confidence: number;
  indexTip: Point2D;
  thumbTip: Point2D;
  wrist: Point2D;
  palmCenter: Point2D;
  /**
   * Apparent palm size (wrist to middle knuckle), video-normalized. Doubles as
   * the bystander-rejection yardstick and as this app's depth proxy: a bigger
   * palm is a nearer palm (see handMask.ts).
   */
  span: number;
  /**
   * All 21 MediaPipe landmarks, video-normalized. The occlusion hull needs the
   * full silhouette, not just the named fingertips.
   */
  landmarks: Point2D[];
};

/** The two driving hands, held in stable slots across frames. */
export type AssignedHands = {
  left: TrackedHand | null;
  right: TrackedHand | null;
};
