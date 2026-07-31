/** Jitter reduction. Pure maths, no DOM, unit tested. */

import type { Point2D } from "./types.ts";

/** Frame time the raw `alpha` is calibrated against (60 FPS). */
export const REFERENCE_DT = 1 / 60;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

const isFinitePoint = (p: Point2D): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);

/**
 * Converts a per-reference-frame smoothing factor into one appropriate for an
 * arbitrary `dt`, so the filter behaves the same at 30 and at 144 FPS.
 */
export function frameRateAdjustedAlpha(alpha: number, dt: number): number {
  const a = clamp(alpha, 0, 1);
  if (a >= 1) return 1;
  if (!Number.isFinite(dt) || dt <= 0) return a;
  return 1 - Math.pow(1 - a, dt / REFERENCE_DT);
}

/**
 * Exponential moving average over a 2D point:
 *
 *     smoothed = previous + alpha * (current - previous)
 *
 * The *whole point* is smoothed, never width/height independently, so the
 * portal keeps coherent motion instead of breathing at the edges.
 */
export class Vec2Smoother {
  private value: Point2D | null = null;
  private alpha: number;

  constructor(alpha = 0.35) {
    this.alpha = clamp(alpha, 0.001, 1);
  }

  setAlpha(alpha: number): void {
    if (!Number.isFinite(alpha)) return;
    this.alpha = clamp(alpha, 0.001, 1);
  }

  getAlpha(): number {
    return this.alpha;
  }

  /** Drops history. The next measurement is adopted verbatim. */
  reset(to?: Point2D): void {
    this.value = to && isFinitePoint(to) ? { x: to.x, y: to.y } : null;
  }

  get current(): Point2D | null {
    return this.value ? { x: this.value.x, y: this.value.y } : null;
  }

  get initialized(): boolean {
    return this.value !== null;
  }

  /**
   * Feeds one measurement and returns the smoothed point.
   * Non-finite input is ignored (the previous value is held) so a bad landmark
   * can never poison the filter with NaN.
   */
  update(measurement: Point2D, dt: number = REFERENCE_DT): Point2D {
    if (!isFinitePoint(measurement)) {
      return this.current ?? { x: 0, y: 0 };
    }
    if (this.value === null) {
      this.value = { x: measurement.x, y: measurement.y };
      return { ...this.value };
    }
    const a = frameRateAdjustedAlpha(this.alpha, dt);
    this.value.x += a * (measurement.x - this.value.x);
    this.value.y += a * (measurement.y - this.value.y);
    return { x: this.value.x, y: this.value.y };
  }
}

/**
 * Time-based scalar damping toward a target, used for portal visibility.
 * `halfLife` is the time in seconds to cover half the remaining distance,
 * which makes fades frame-rate independent.
 */
export function dampTowards(current: number, target: number, halfLife: number, dt: number): number {
  if (!Number.isFinite(current)) return target;
  if (halfLife <= 0 || !Number.isFinite(dt) || dt <= 0) return target;
  const k = 1 - Math.pow(0.5, dt / halfLife);
  const next = current + (target - current) * k;
  return Math.abs(target - next) < 1e-4 ? target : next;
}
