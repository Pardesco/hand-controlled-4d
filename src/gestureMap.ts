/**
 * Grip-and-pull: two pinched hands -> six 4D rotation-plane increments.
 *
 * Pure maths, no DOM, unit tested. All positions are display-space points that
 * the caller has already aspect-corrected (x multiplied by width/height), so a
 * distance of 0.1 is a tenth of the canvas height in every direction and
 * angles are true screen angles.
 *
 * The mapping (spec §2.1):
 *
 *   distance between hands          -> ZW   pulling it inside out
 *   orientation of the hand vector  -> XY   turning it like a wheel
 *   vertical offset between hands   -> YW   tipping it through itself
 *   mean wrist twist                -> XW   screwing it into another axis
 *   mean hand position              -> XZ / YZ   orbiting around it
 *
 * Control is *incremental* (spec §2.3): each engaged frame contributes the
 * delta of each signal, scaled by a gain. Absolute mapping would snap on
 * re-acquisition and cap total rotation at the user's physical range.
 *
 * The clutch (spec §2.2): increments accumulate only while BOTH hands are
 * pinched. Release, reposition, re-pinch continues from where the object was
 * -- exactly like lifting a mouse. The first engaged frame only primes the
 * previous-signal state and contributes nothing, which is what makes
 * re-engagement seamless.
 *
 * Inertia ("the throw"): releasing the clutch mid-motion carries the current
 * smoothed rates into a free spin that decays with adjustable friction (zero
 * friction spins forever). This is what lets a single pull keep the polytope
 * turning after the hands run out of screen -- spin it like a globe and let
 * go. Re-gripping takes hold of the object and stops the free spin, which is
 * exactly what grabbing a spinning globe does.
 */

import { clamp, frameRateAdjustedAlpha, REFERENCE_DT } from "./smoothing.ts";
import { PLANES, type PlaneAngles } from "./polytope4d.ts";
import type { Point2D } from "./types.ts";

/** One hand as the gesture layer sees it. Aspect-corrected display space. */
export type GestureHandInput = {
  /** Midpoint of thumb tip and index tip -- where the "grip" is. */
  pinchPoint: Point2D;
  /** Thumb tip to index tip distance. */
  pinchDistance: number;
  /** Palm span (wrist to middle knuckle), the pinch yardstick. */
  span: number;
  /** Angle of the wrist -> middle-knuckle vector, radians. */
  twistAngle: number;
};

export type GestureGains = {
  /** Hand separation -> ZW, radians per unit of separation change. */
  zw: number;
  /** Hand-pair angle -> XY, radians per radian. */
  xy: number;
  /** Vertical offset -> YW, radians per unit. */
  yw: number;
  /** Mean wrist twist -> XW, radians per radian. */
  xw: number;
  /** Mean position -> XZ (horizontal) and YZ (vertical) view orbit. */
  orbit: number;
};

export type GestureOptions = {
  gains: GestureGains;
  /** Pinch engages below this fraction of palm span... */
  pinchEngageRatio: number;
  /** ...and releases above this one. Hysteresis stops flicker at the boundary. */
  pinchReleaseRatio: number;
  /** EMA factor for the output rates, calibrated at 60 FPS. */
  rateSmoothingAlpha: number;
  /** Hard cap on any single plane increment per frame, radians. */
  maxStepRadians: number;
  /** Releasing mid-motion throws the object into a free spin. */
  inertia: boolean;
  /** Fraction of free-spin velocity lost per second. 0 = spins forever. */
  spinFriction: number;
};

export const DEFAULT_GESTURE_OPTIONS: GestureOptions = {
  gains: { zw: 4.0, xy: 1.0, yw: 2.2, xw: 1.0, orbit: 2.2 },
  pinchEngageRatio: 0.45,
  pinchReleaseRatio: 0.7,
  rateSmoothingAlpha: 0.5,
  maxStepRadians: 0.2,
  inertia: true,
  spinFriction: 0.15,
};

/** Free-spin velocities below this are snapped to zero, radians/second. */
const SPIN_EPSILON = 1e-4;

/** Wraps to (-PI, PI] so an angle crossing the +/-PI seam gives a small delta. */
export function wrapAngle(angle: number): number {
  let a = angle % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

export type GestureFrame = {
  /** True while both hands are pinched: rotation is accumulating. */
  engaged: boolean;
  /** True while a released throw is still carrying the rotation. */
  spinning: boolean;
  leftPinched: boolean;
  rightPinched: boolean;
  /** This frame's rotation increments, radians. Zero unless engaged or spinning. */
  increments: PlaneAngles;
};

/** The raw signals the deltas are taken over. */
type Signals = {
  separation: number;
  pairAngle: number;
  verticalOffset: number;
  twist: number;
  meanX: number;
  meanY: number;
};

export class GestureMapper {
  private options: GestureOptions;
  private leftPinched = false;
  private rightPinched = false;
  private engaged = false;
  private previous: Signals | null = null;
  /** Smoothed per-plane rates (radians/second), for spec §7's second damping. */
  private readonly rates: PlaneAngles = { XY: 0, XZ: 0, XW: 0, YZ: 0, YW: 0, ZW: 0 };
  /** Rates carried past a release -- the throw. Radians/second. */
  private readonly freeVelocity: PlaneAngles = { XY: 0, XZ: 0, XW: 0, YZ: 0, YW: 0, ZW: 0 };
  /** Reused output object -- the render loop must not allocate. */
  private readonly frame: GestureFrame = {
    engaged: false,
    spinning: false,
    leftPinched: false,
    rightPinched: false,
    increments: { XY: 0, XZ: 0, XW: 0, YZ: 0, YW: 0, ZW: 0 },
  };

  constructor(options: Partial<GestureOptions> = {}) {
    this.options = {
      ...DEFAULT_GESTURE_OPTIONS,
      ...options,
      gains: { ...DEFAULT_GESTURE_OPTIONS.gains, ...(options.gains ?? {}) },
    };
  }

  setOptions(options: Partial<GestureOptions>): void {
    this.options = {
      ...this.options,
      ...options,
      gains: { ...this.options.gains, ...(options.gains ?? {}) },
    };
  }

  /** Hysteresis pinch: engage and release thresholds differ. */
  private updatePinch(current: boolean, hand: GestureHandInput | null): boolean {
    if (!hand || hand.span <= 1e-6) return false;
    const ratio = hand.pinchDistance / hand.span;
    if (current) return ratio < this.options.pinchReleaseRatio;
    return ratio < this.options.pinchEngageRatio;
  }

  private readSignals(left: GestureHandInput, right: GestureHandInput, out: Signals): Signals {
    const dx = right.pinchPoint.x - left.pinchPoint.x;
    const dy = right.pinchPoint.y - left.pinchPoint.y;
    out.separation = Math.hypot(dx, dy);
    out.pairAngle = Math.atan2(dy, dx);
    out.verticalOffset = dy;
    // Per-hand twist angles are averaged as *deltas*, never as angles, so the
    // +/-PI seam of one wrist cannot poison the mean. See update().
    out.twist = 0;
    out.meanX = (left.pinchPoint.x + right.pinchPoint.x) * 0.5;
    out.meanY = (left.pinchPoint.y + right.pinchPoint.y) * 0.5;
    return out;
  }

  private readonly scratchSignals: Signals = {
    separation: 0,
    pairAngle: 0,
    verticalOffset: 0,
    twist: 0,
    meanX: 0,
    meanY: 0,
  };
  private previousTwistLeft = 0;
  private previousTwistRight = 0;

  /**
   * Feed one frame. `left`/`right` may be null when tracking dropped a hand;
   * that releases the clutch.
   */
  update(left: GestureHandInput | null, right: GestureHandInput | null, dt: number): GestureFrame {
    const safeDt = Number.isFinite(dt) && dt > 1e-4 ? dt : REFERENCE_DT;

    this.leftPinched = this.updatePinch(this.leftPinched, left);
    this.rightPinched = this.updatePinch(this.rightPinched, right);
    const engagedNow = this.leftPinched && this.rightPinched && left !== null && right !== null;

    const frame = this.frame;
    frame.leftPinched = this.leftPinched;
    frame.rightPinched = this.rightPinched;
    frame.engaged = engagedNow;
    frame.spinning = false;
    for (const plane of PLANES) frame.increments[plane] = 0;

    if (!engagedNow) {
      // Clutch open. The rate memory is dropped so a re-engage cannot replay
      // motion from before the release -- but on the release transition the
      // last smoothed rates become the throw.
      if (this.engaged && this.options.inertia) {
        for (const plane of PLANES) this.freeVelocity[plane] = this.rates[plane];
      }
      this.engaged = false;
      this.previous = null;
      for (const plane of PLANES) this.rates[plane] = 0;

      if (!this.options.inertia) {
        for (const plane of PLANES) this.freeVelocity[plane] = 0;
        return frame;
      }
      // Free spin: exponential friction, frame-rate independent.
      const keep = Math.pow(1 - clamp(this.options.spinFriction, 0, 0.999), safeDt);
      let spinning = false;
      for (const plane of PLANES) {
        let velocity = this.freeVelocity[plane] * keep;
        if (Math.abs(velocity) < SPIN_EPSILON) velocity = 0;
        this.freeVelocity[plane] = velocity;
        frame.increments[plane] = clamp(
          velocity * safeDt,
          -this.options.maxStepRadians,
          this.options.maxStepRadians
        );
        if (velocity !== 0) spinning = true;
      }
      frame.spinning = spinning;
      return frame;
    }

    // The grip takes hold of the object: a grab stops any free spin dead,
    // exactly like catching a spinning globe.
    for (const plane of PLANES) this.freeVelocity[plane] = 0;
    frame.spinning = false;

    const signals = this.readSignals(left!, right!, this.scratchSignals);
    const twistLeft = left!.twistAngle;
    const twistRight = right!.twistAngle;

    if (!this.engaged || this.previous === null) {
      // First engaged frame: prime the deltas, contribute nothing (spec §2.2).
      this.engaged = true;
      this.previous = { ...signals };
      this.previousTwistLeft = twistLeft;
      this.previousTwistRight = twistRight;
      return frame;
    }

    const { gains, rateSmoothingAlpha, maxStepRadians } = this.options;
    const previous = this.previous;

    const twistDelta =
      (wrapAngle(twistLeft - this.previousTwistLeft) +
        wrapAngle(twistRight - this.previousTwistRight)) *
      0.5;

    // Raw rates in radians/second, from signal deltas.
    const rawRates: PlaneAngles = {
      ZW: ((signals.separation - previous.separation) * gains.zw) / safeDt,
      XY: (wrapAngle(signals.pairAngle - previous.pairAngle) * gains.xy) / safeDt,
      YW: ((signals.verticalOffset - previous.verticalOffset) * gains.yw) / safeDt,
      XW: (twistDelta * gains.xw) / safeDt,
      XZ: ((signals.meanX - previous.meanX) * gains.orbit) / safeDt,
      YZ: ((signals.meanY - previous.meanY) * gains.orbit) / safeDt,
    };

    // Second damping stage (spec §7): rate is a derivative of tracked input,
    // so jitter is amplified -- smooth the rates, not just the positions.
    const alpha = frameRateAdjustedAlpha(rateSmoothingAlpha, safeDt);
    for (const plane of PLANES) {
      this.rates[plane] += alpha * (rawRates[plane] - this.rates[plane]);
      frame.increments[plane] = clamp(
        this.rates[plane] * safeDt,
        -maxStepRadians,
        maxStepRadians
      );
    }

    this.previous.separation = signals.separation;
    this.previous.pairAngle = signals.pairAngle;
    this.previous.verticalOffset = signals.verticalOffset;
    this.previous.meanX = signals.meanX;
    this.previous.meanY = signals.meanY;
    this.previousTwistLeft = twistLeft;
    this.previousTwistRight = twistRight;
    return frame;
  }

  /** Drops all state; used when tracking restarts or the camera changes. */
  reset(): void {
    this.leftPinched = false;
    this.rightPinched = false;
    this.engaged = false;
    this.previous = null;
    for (const plane of PLANES) {
      this.rates[plane] = 0;
      this.freeVelocity[plane] = 0;
    }
  }
}
