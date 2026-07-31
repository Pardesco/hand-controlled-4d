/**
 * The two-handed instrument (Guiard's kinematic chain, spec §2.4):
 *
 *   SELECTOR hand (screen-right by default, assigned by POSITION, never by
 *   MediaPipe handedness labels -- those are inverted on many webcams):
 *   tap a fingertip against the thumb to select a plane, hold the touch to
 *   keep it selected:
 *     thumb+index -> ZW, thumb+middle -> YW, thumb+ring -> XW,
 *     thumb+pinky -> XY.
 *   PEDAL hand (the other one) -- ONE speed control:
 *     pinch-and-hold accelerates whatever the selector has tapped,
 *     release and it coasts, decaying with friction,
 *     fist = full brake.
 *
 * Each plane owns a persistent velocity; the pedal only feeds the currently
 * selected one(s), previously spun planes coast on friction. With no pedal
 * hand in frame, a selector tap drives its plane directly at a fixed hold
 * rate, so one-hand operation works.
 *
 * A fist physically contains a pinch (the thumb rests against the curled
 * index), so the fist is checked FIRST and wins on the pedal hand.
 *
 * Pure maths, no DOM, unit tested. History: v1 symmetric finger-holds on
 * both hands (unreadable); v2 swipe-speed throttle ("waving at the camera");
 * v3 fold-to-palm selection + pedal (folds fought the pinch detector and
 * label-based hand roles landed on the wrong physical hands). Thumb-tap
 * selection is v4 -- it is the gesture users actually make when told to
 * "touch a finger".
 */

import { clamp, REFERENCE_DT } from "./smoothing.ts";
import { PLANES, type PlaneAngles, type RotationPlane } from "./polytope4d.ts";
import type { TrackedHand } from "./types.ts";

/**
 * Fingertip landmark, the plane a thumb-tap on it drives, and the indicator
 * colour shown at that fingertip (also the on-camera legend). MCP indices
 * are used for the pedal hand's fist detection.
 */
export const FINGER_MAP = [
  { name: "index", tip: 8, mcp: 5, plane: "ZW" as RotationPlane, color: "#ff4fa3" },
  { name: "middle", tip: 12, mcp: 9, plane: "YW" as RotationPlane, color: "#35e0d6" },
  { name: "ring", tip: 16, mcp: 13, plane: "XW" as RotationPlane, color: "#ff8a3d" },
  { name: "pinky", tip: 20, mcp: 17, plane: "XY" as RotationPlane, color: "#ffd23d" },
] as const;

export const THUMB_TIP = 4;

export type PlaneDriveOptions = {
  /** Direct-drive rate for the no-pedal-hand fallback, radians/second. */
  holdRate: number;
  /** Pedal (pinch held) acceleration, radians/second^2. */
  pedalAccel: number;
  /** Cap on any plane's velocity, radians/second. */
  maxRate: number;
  /** Fraction of plane velocity lost per second while coasting. 0 = forever. */
  friction: number;
  /** Selector: thumb-to-fingertip / span below this reads as a tap... */
  touchRatio: number;
  /** ...and above this as released again. */
  untouchRatio: number;
  /** Pedal: thumb-to-index / span thresholds (same meaning as the grip pinch). */
  pinchEngageRatio: number;
  pinchReleaseRatio: number;
  /** Fist: every fingertip-to-own-MCP / span below this. */
  foldRatio: number;
  unfoldRatio: number;
};

export const DEFAULT_PLANE_DRIVE_OPTIONS: PlaneDriveOptions = {
  holdRate: 0.9,
  pedalAccel: 2.5,
  maxRate: 3,
  friction: 0.3,
  touchRatio: 0.3,
  untouchRatio: 0.45,
  pinchEngageRatio: 0.45,
  pinchReleaseRatio: 0.7,
  foldRatio: 0.45,
  unfoldRatio: 0.62,
};

/** Braking halves the velocity every this many seconds. */
const BRAKE_HALF_LIFE = 0.12;
/** Velocities below this snap to zero, radians/second. */
const SPIN_EPSILON = 1e-3;
/** How quickly the fallback direct drive ramps toward its target rate. */
const FALLBACK_RAMP = 8;

export type TouchState = {
  index: boolean;
  middle: boolean;
  ring: boolean;
  pinky: boolean;
};

/**
 * How close each fingertip is to the thumb, 0 (far) to 1 (touching). Purely a
 * report — it is derived from the same ratio the hysteresis already computes
 * and feeds nothing back into selection. The UI uses it to show a plane being
 * approached before contact latches.
 */
export type TouchProximity = {
  index: number;
  middle: number;
  ring: number;
  pinky: number;
};

function emptyTouches(): TouchState {
  return { index: false, middle: false, ring: false, pinky: false };
}

function emptyProximity(): TouchProximity {
  return { index: 0, middle: 0, ring: 0, pinky: 0 };
}

function clearTouches(touches: TouchState): void {
  touches.index = touches.middle = touches.ring = touches.pinky = false;
}

export type PlaneDriveFrame = {
  /** This frame's rotation increments, radians. */
  increments: PlaneAngles;
  /** Persistent per-plane velocities, radians/second (read-only view). */
  velocities: Readonly<PlaneAngles>;
  /** Selector thumb-taps, for the fingertip indicators. */
  touches: TouchState;
  /** Report-only approach distance per finger, for the plane matrix. */
  proximity: TouchProximity;
  /** True when at least one plane is selected. */
  selecting: boolean;
  /** True while the pedal is held (pedal hand pinched, not a fist). */
  pedal: boolean;
  /** True while any plane still carries velocity. */
  spinning: boolean;
  /** True while the pedal-hand fist is damping everything. */
  braking: boolean;
};

export class PlaneDriveMapper {
  private options: PlaneDriveOptions;
  private readonly touches = emptyTouches();
  private readonly proximity = emptyProximity();
  private pedalPinched = false;
  private fist = false;
  private readonly velocities: PlaneAngles = { XY: 0, XZ: 0, XW: 0, YZ: 0, YW: 0, ZW: 0 };
  /** Reused output object -- the render loop must not allocate. */
  private readonly frame: PlaneDriveFrame = {
    increments: { XY: 0, XZ: 0, XW: 0, YZ: 0, YW: 0, ZW: 0 },
    velocities: this.velocities,
    touches: this.touches,
    proximity: this.proximity,
    selecting: false,
    pedal: false,
    spinning: false,
    braking: false,
  };

  constructor(options: Partial<PlaneDriveOptions> = {}) {
    this.options = { ...DEFAULT_PLANE_DRIVE_OPTIONS, ...options };
  }

  setOptions(options: Partial<PlaneDriveOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /** Thumb-tap selection with hysteresis, scale-invariant via palm span. */
  private updateTouches(selector: TrackedHand | null): void {
    if (!selector || selector.span <= 1e-6 || selector.landmarks.length < 21) {
      clearTouches(this.touches);
      for (const finger of FINGER_MAP) this.proximity[finger.name] = 0;
      return;
    }
    const { touchRatio, untouchRatio } = this.options;
    const thumb = selector.landmarks[THUMB_TIP]!;
    // Anything beyond this reads as "not reaching for a plane at all".
    const far = untouchRatio * 2;
    for (const finger of FINGER_MAP) {
      const tip = selector.landmarks[finger.tip]!;
      const ratio = Math.hypot(tip.x - thumb.x, tip.y - thumb.y) / selector.span;
      const current = this.touches[finger.name];
      const touched = current ? ratio < untouchRatio : ratio < touchRatio;
      this.touches[finger.name] = touched;
      this.proximity[finger.name] = touched
        ? 1
        : clamp((far - ratio) / (far - touchRatio || 1), 0, 1);
    }
  }

  /** Pedal-hand pinch and fist, both with hysteresis. Fist wins. */
  private updatePedal(pedal: TrackedHand | null): void {
    if (!pedal || pedal.span <= 1e-6 || pedal.landmarks.length < 21) {
      this.pedalPinched = false;
      this.fist = false;
      return;
    }
    const { pinchEngageRatio, pinchReleaseRatio, foldRatio, unfoldRatio } = this.options;
    const span = pedal.span;

    // Fist: every fingertip near its own knuckle.
    let folded = 0;
    for (const finger of FINGER_MAP) {
      const tip = pedal.landmarks[finger.tip]!;
      const mcp = pedal.landmarks[finger.mcp]!;
      const ratio = Math.hypot(tip.x - mcp.x, tip.y - mcp.y) / span;
      const limit = this.fist ? unfoldRatio : foldRatio;
      if (ratio < limit) folded += 1;
    }
    this.fist = folded === FINGER_MAP.length;

    const thumb = pedal.landmarks[THUMB_TIP]!;
    const index = pedal.landmarks[FINGER_MAP[0].tip]!;
    const pinchRatio = Math.hypot(index.x - thumb.x, index.y - thumb.y) / span;
    this.pedalPinched = this.pedalPinched
      ? pinchRatio < pinchReleaseRatio
      : pinchRatio < pinchEngageRatio;
  }

  update(selector: TrackedHand | null, pedal: TrackedHand | null, dt: number): PlaneDriveFrame {
    const safeDt = clamp(Number.isFinite(dt) && dt > 1e-4 ? dt : REFERENCE_DT, 1e-4, 0.25);
    const options = this.options;
    const frame = this.frame;
    for (const plane of PLANES) frame.increments[plane] = 0;

    this.updateTouches(selector);
    this.updatePedal(pedal);

    const braking = this.fist;
    const pedalDown = pedal !== null && this.pedalPinched && !braking;

    let selecting = false;
    if (!braking) {
      for (const finger of FINGER_MAP) {
        if (!this.touches[finger.name]) continue;
        selecting = true;
        const plane = finger.plane;
        if (pedal !== null) {
          // Pedal down: constant acceleration. Pedal up: coast (below).
          if (pedalDown) this.velocities[plane] += options.pedalAccel * safeDt;
        } else {
          // One-hand fallback: ramp toward the fixed hold rate.
          this.velocities[plane] +=
            (options.holdRate - this.velocities[plane]) * Math.min(1, safeDt * FALLBACK_RAMP);
        }
      }
    }

    // Coasting friction always applies; the brake is just far stronger.
    const keep = braking
      ? Math.pow(0.5, safeDt / BRAKE_HALF_LIFE)
      : Math.pow(1 - clamp(options.friction, 0, 0.999), safeDt);

    let spinning = false;
    for (const plane of PLANES) {
      let velocity = clamp(this.velocities[plane] * keep, -options.maxRate, options.maxRate);
      if (Math.abs(velocity) < SPIN_EPSILON) velocity = 0;
      this.velocities[plane] = velocity;
      frame.increments[plane] = velocity * safeDt;
      if (velocity !== 0) spinning = true;
    }

    frame.selecting = selecting;
    frame.pedal = pedalDown;
    frame.spinning = spinning;
    frame.braking = braking;
    return frame;
  }

  reset(): void {
    clearTouches(this.touches);
    for (const finger of FINGER_MAP) this.proximity[finger.name] = 0;
    this.pedalPinched = false;
    this.fist = false;
    for (const plane of PLANES) this.velocities[plane] = 0;
  }
}
