/**
 * KeyboardDrive — the no-hands fallback (DESIGN.md §11).
 *
 * Deliberately a separate control path rather than a synthetic hand fed into
 * `planeDrive.ts`: the gesture pipeline stays untouched, and its thresholds,
 * hysteresis and velocity model are not asked to serve two masters. This class
 * reuses the *user's* motion settings (pedal acceleration, speed cap, friction)
 * so keyboard drive feels identical to pedal drive, and its increments are
 * summed alongside the gesture increments in `app.ts`.
 *
 * Latch a plane in the RotationPlaneMatrix, then hold W to accelerate or S to
 * brake — the same three verbs the hands have.
 */

import { clamp } from "../smoothing.ts";
import { PLANES, type PlaneAngles, type RotationPlane } from "../polytope4d.ts";

export type KeyboardDriveOptions = {
  pedalAccel: number;
  maxRate: number;
  friction: number;
};

/** Matches BRAKE_HALF_LIFE in planeDrive.ts so both brakes feel the same. */
const BRAKE_HALF_LIFE = 0.12;
const SPIN_EPSILON = 1e-3;

export class KeyboardDrive {
  private options: KeyboardDriveOptions;
  private readonly velocities: PlaneAngles = { XY: 0, XZ: 0, XW: 0, YZ: 0, YW: 0, ZW: 0 };
  private readonly latchedPlanes = new Set<RotationPlane>();
  private readonly increments: PlaneAngles = { XY: 0, XZ: 0, XW: 0, YZ: 0, YW: 0, ZW: 0 };

  accelerating = false;
  braking = false;

  constructor(options: KeyboardDriveOptions) {
    this.options = { ...options };
  }

  setOptions(options: KeyboardDriveOptions): void {
    this.options = { ...options };
  }

  get latched(): ReadonlySet<RotationPlane> {
    return this.latchedPlanes;
  }

  setLatched(plane: RotationPlane, latched: boolean): void {
    if (latched) this.latchedPlanes.add(plane);
    else this.latchedPlanes.delete(plane);
  }

  /** True while this path is contributing anything at all. */
  get engaged(): boolean {
    return this.latchedPlanes.size > 0 || this.accelerating || this.braking;
  }

  update(dt: number): Readonly<PlaneAngles> {
    const safeDt = clamp(Number.isFinite(dt) && dt > 1e-4 ? dt : 1 / 60, 1e-4, 0.25);
    const { pedalAccel, maxRate, friction } = this.options;

    if (this.accelerating && !this.braking) {
      for (const plane of this.latchedPlanes) {
        this.velocities[plane] += pedalAccel * safeDt;
      }
    }

    const keep = this.braking
      ? Math.pow(0.5, safeDt / BRAKE_HALF_LIFE)
      : Math.pow(1 - clamp(friction, 0, 0.999), safeDt);

    for (const plane of PLANES) {
      let velocity = clamp(this.velocities[plane] * keep, -maxRate, maxRate);
      if (Math.abs(velocity) < SPIN_EPSILON) velocity = 0;
      this.velocities[plane] = velocity;
      this.increments[plane] = velocity * safeDt;
    }
    return this.increments;
  }

  /** Per-plane velocities, for the matrix bars. */
  get planeVelocities(): Readonly<PlaneAngles> {
    return this.velocities;
  }

  reset(): void {
    for (const plane of PLANES) this.velocities[plane] = 0;
    this.accelerating = false;
    this.braking = false;
  }
}
