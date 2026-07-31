/**
 * MediaPipe Tasks Vision Hand Landmarker, video mode.
 *
 * Responsibility ends at "here are the hands in video-normalized coordinates".
 * It knows nothing about the polytope, the gesture mapping, or the display
 * transform. Lifted from hand-tracked-ascii-portal; the one change is that
 * TrackedHand now carries all 21 landmarks for the occlusion hull.
 */

import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import { AppError } from "./camera.ts";
import type { Handedness, Point2D, TrackedHand } from "./types.ts";

/** MediaPipe hand landmark indices we care about by name. */
export const LANDMARK = {
  wrist: 0,
  thumbTip: 4,
  indexMcp: 5,
  indexTip: 8,
  middleMcp: 9,
  ringMcp: 13,
  pinkyMcp: 17,
} as const;

export const LANDMARK_COUNT = 21;

/** Landmarks averaged into a stable palm centre for hand-to-slot matching. */
const PALM_LANDMARKS = [
  LANDMARK.wrist,
  LANDMARK.indexMcp,
  LANDMARK.middleMcp,
  LANDMARK.ringMcp,
  LANDMARK.pinkyMcp,
] as const;

export type TrackerOptions = {
  minHandDetectionConfidence: number;
  minHandPresenceConfidence: number;
  minTrackingConfidence: number;
  /**
   * How many hands the model reports. The app only ever uses two, but asking
   * for more is what makes bystanders survivable: at numHands = 2 MediaPipe
   * itself picks which two hands to return, that choice is not stable between
   * frames, and the app never sees the alternatives to choose better.
   */
  numHands: number;
};

export const DEFAULT_TRACKER_OPTIONS: TrackerOptions = {
  minHandDetectionConfidence: 0.5,
  minHandPresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
  numHands: 4,
};

type Landmark = { x: number; y: number };

function toPoint(landmarks: readonly Landmark[], index: number): Point2D {
  const lm = landmarks[index];
  return lm ? { x: lm.x, y: lm.y } : { x: 0, y: 0 };
}

/** Wrist to middle-finger knuckle: a stable stand-in for how big this hand looks. */
function palmSpan(landmarks: readonly Landmark[]): number {
  const wrist = landmarks[LANDMARK.wrist];
  const middle = landmarks[LANDMARK.middleMcp];
  if (!wrist || !middle) return 0;
  return Math.hypot(middle.x - wrist.x, middle.y - wrist.y);
}

function palmCenter(landmarks: readonly Landmark[]): Point2D {
  let x = 0;
  let y = 0;
  let n = 0;
  for (const index of PALM_LANDMARKS) {
    const lm = landmarks[index];
    if (!lm) continue;
    x += lm.x;
    y += lm.y;
    n += 1;
  }
  return n > 0 ? { x: x / n, y: y / n } : { x: 0.5, y: 0.5 };
}

export class HandTracker {
  private landmarker: HandLandmarker;
  private lastVideoTime = -1;
  private closed = false;

  /** Reused across frames -- the render loop must not allocate. */
  private readonly scratch: TrackedHand[] = [];

  private constructor(landmarker: HandLandmarker) {
    this.landmarker = landmarker;
  }

  static async create(
    options: TrackerOptions = DEFAULT_TRACKER_OPTIONS,
    baseUrl: string = import.meta.env.BASE_URL
  ): Promise<HandTracker> {
    const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    try {
      // Both the WASM runtime and the model are served from this app's own
      // origin (see scripts/setup-assets.mjs). Nothing is fetched from a CDN.
      const fileset = await FilesetResolver.forVisionTasks(`${base}mediapipe/wasm`);
      const landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: `${base}models/hand_landmarker.task`,
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        ...options,
      });
      return new HandTracker(landmarker);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new AppError(
        "model-load-failed",
        `The hand tracking model failed to load (${detail}). Run "npm run assets" to fetch public/models/hand_landmarker.task.`
      );
    }
  }

  async setOptions(options: Partial<TrackerOptions>): Promise<void> {
    if (this.closed) return;
    await this.landmarker.setOptions(options);
  }

  /**
   * Runs one inference, but only if the video has advanced.
   *
   * @returns the hands for this frame, or `null` when the frame was a duplicate
   *          (the caller should keep using its previous result -- rendering is
   *          deliberately decoupled from tracking rate).
   */
  detect(video: HTMLVideoElement, timestampMs: number): TrackedHand[] | null {
    if (this.closed) return null;
    if (video.readyState < 2 || video.videoWidth === 0) return null;
    if (video.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = video.currentTime;

    const result = this.landmarker.detectForVideo(video, timestampMs);
    this.scratch.length = 0;

    for (let i = 0; i < result.landmarks.length; i += 1) {
      const landmarks = result.landmarks[i];
      if (!landmarks || landmarks.length < LANDMARK_COUNT) continue;
      const category = result.handedness[i]?.[0];
      const label: Handedness = category?.categoryName === "Left" ? "Left" : "Right";
      const points: Point2D[] = new Array(LANDMARK_COUNT);
      for (let k = 0; k < LANDMARK_COUNT; k += 1) points[k] = toPoint(landmarks, k);
      this.scratch.push({
        handedness: label,
        confidence: category?.score ?? 0,
        indexTip: toPoint(landmarks, LANDMARK.indexTip),
        thumbTip: toPoint(landmarks, LANDMARK.thumbTip),
        wrist: toPoint(landmarks, LANDMARK.wrist),
        palmCenter: palmCenter(landmarks),
        span: palmSpan(landmarks),
        landmarks: points,
      });
    }
    return this.scratch;
  }

  /** Forces the next `detect()` to run even on the same video timestamp. */
  invalidate(): void {
    this.lastVideoTime = -1;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.landmarker.close();
  }
}

/**
 * MediaPipe derives its handedness label from the *raw* camera image, while the
 * app shows a mirrored selfie view. Whether "Left" reads as the user's left on
 * screen therefore depends on the camera, so the label swap is a user-visible
 * setting rather than a hard-coded constant. Gesture geometry is unaffected --
 * only the debug labels and slot naming are.
 */
export function applyHandednessSwap(hands: TrackedHand[], swap: boolean): TrackedHand[] {
  if (!swap) return hands;
  for (const hand of hands) {
    hand.handedness = hand.handedness === "Left" ? "Right" : "Left";
  }
  return hands;
}
