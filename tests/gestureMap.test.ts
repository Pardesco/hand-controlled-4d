import { describe, expect, it } from "vitest";
import {
  DEFAULT_GESTURE_OPTIONS,
  GestureMapper,
  wrapAngle,
  type GestureHandInput,
} from "../src/gestureMap.ts";
import { PLANES } from "../src/polytope4d.ts";

const DT = 1 / 60;

/** A hand at `x, y`, pinched or open, neutral twist unless given. */
function hand(
  x: number,
  y: number,
  pinched: boolean,
  twistAngle = 0
): GestureHandInput {
  return {
    pinchPoint: { x, y },
    pinchDistance: pinched ? 0.03 : 0.12,
    span: 0.12,
    twistAngle,
  };
}

/** Runs one update with both hands engaged at the given positions. */
function step(
  mapper: GestureMapper,
  lx: number,
  ly: number,
  rx: number,
  ry: number,
  twist = 0
) {
  return mapper.update(hand(lx, ly, true, twist), hand(rx, ry, true, twist), DT);
}

function expectAllZero(increments: Record<string, number>): void {
  for (const plane of PLANES) expect(increments[plane]).toBe(0);
}

describe("pinch clutch", () => {
  it("does not engage with open hands", () => {
    const mapper = new GestureMapper();
    const frame = mapper.update(hand(0.3, 0.5, false), hand(0.7, 0.5, false), DT);
    expect(frame.engaged).toBe(false);
    expectAllZero(frame.increments);
  });

  it("does not engage with only one hand pinched", () => {
    const mapper = new GestureMapper();
    const frame = mapper.update(hand(0.3, 0.5, true), hand(0.7, 0.5, false), DT);
    expect(frame.engaged).toBe(false);
    expect(frame.leftPinched).toBe(true);
    expect(frame.rightPinched).toBe(false);
  });

  it("does not engage when a hand is missing, even mid-gesture", () => {
    const mapper = new GestureMapper();
    step(mapper, 0.3, 0.5, 0.7, 0.5);
    const frame = mapper.update(hand(0.3, 0.5, true), null, DT);
    expect(frame.engaged).toBe(false);
    expectAllZero(frame.increments);
  });

  it("uses hysteresis between the engage and release ratios", () => {
    const mapper = new GestureMapper();
    const between: GestureHandInput = {
      pinchPoint: { x: 0.5, y: 0.5 },
      // ratio 0.55: above engage (0.45), below release (0.7)
      pinchDistance: 0.066,
      span: 0.12,
      twistAngle: 0,
    };
    // Not pinched yet: 0.55 does not cross the engage threshold.
    let frame = mapper.update(between, between, DT);
    expect(frame.leftPinched).toBe(false);
    // Pinch fully, then return to the in-between ratio: still held.
    mapper.update(hand(0.5, 0.5, true), hand(0.5, 0.5, true), DT);
    frame = mapper.update(between, between, DT);
    expect(frame.leftPinched).toBe(true);
    expect(frame.rightPinched).toBe(true);
  });

  it("contributes nothing on the first engaged frame (no snap)", () => {
    const mapper = new GestureMapper();
    const frame = step(mapper, 0.3, 0.5, 0.7, 0.5);
    expect(frame.engaged).toBe(true);
    expectAllZero(frame.increments);
  });

  it("repositioning while released does not replay on re-engage", () => {
    const mapper = new GestureMapper();
    step(mapper, 0.3, 0.5, 0.7, 0.5);
    step(mapper, 0.3, 0.5, 0.75, 0.5); // some ZW motion while engaged
    mapper.update(hand(0.3, 0.5, false), hand(0.75, 0.5, false), DT); // release
    // Hands travel far while open...
    const frame = mapper.update(hand(0.1, 0.2, true), hand(0.9, 0.8, true), DT);
    // ...and the first frame back contributes nothing.
    expectAllZero(frame.increments);
  });
});

describe("grip-and-pull mapping", () => {
  it("pulling hands apart drives ZW and only ZW", () => {
    const mapper = new GestureMapper();
    step(mapper, 0.3, 0.5, 0.7, 0.5);
    const frame = step(mapper, 0.29, 0.5, 0.71, 0.5);
    expect(frame.increments.ZW).toBeGreaterThan(0);
    expect(frame.increments.XY).toBeCloseTo(0, 10);
    expect(frame.increments.YW).toBeCloseTo(0, 10);
    expect(frame.increments.XW).toBeCloseTo(0, 10);
    expect(frame.increments.XZ).toBeCloseTo(0, 10);
    expect(frame.increments.YZ).toBeCloseTo(0, 10);
  });

  it("pushing hands together reverses ZW", () => {
    const mapper = new GestureMapper();
    step(mapper, 0.3, 0.5, 0.7, 0.5);
    const frame = step(mapper, 0.31, 0.5, 0.69, 0.5);
    expect(frame.increments.ZW).toBeLessThan(0);
  });

  it("turning the pair like a wheel drives XY", () => {
    const mapper = new GestureMapper();
    step(mapper, 0.3, 0.5, 0.7, 0.5);
    // Rotate both points around their centre; separation unchanged.
    const angle = 0.1;
    const cx = 0.5;
    const r = 0.2;
    const frame = step(
      mapper,
      cx - r * Math.cos(angle),
      0.5 - r * Math.sin(angle),
      cx + r * Math.cos(angle),
      0.5 + r * Math.sin(angle)
    );
    expect(frame.increments.XY).not.toBeCloseTo(0, 6);
    expect(frame.increments.ZW).toBeCloseTo(0, 8);
  });

  it("mean wrist twist drives XW", () => {
    const mapper = new GestureMapper();
    step(mapper, 0.3, 0.5, 0.7, 0.5, 0);
    const frame = step(mapper, 0.3, 0.5, 0.7, 0.5, 0.15);
    expect(frame.increments.XW).toBeGreaterThan(0);
    expect(frame.increments.ZW).toBeCloseTo(0, 10);
    expect(frame.increments.XY).toBeCloseTo(0, 10);
  });

  it("twist crossing the +/-PI seam stays a small delta", () => {
    const mapper = new GestureMapper();
    step(mapper, 0.3, 0.5, 0.7, 0.5, Math.PI - 0.02);
    const frame = step(mapper, 0.3, 0.5, 0.7, 0.5, -Math.PI + 0.02);
    // 0.04 rad of actual motion, not ~2*PI backwards.
    expect(Math.abs(frame.increments.XW)).toBeLessThan(0.1);
    expect(frame.increments.XW).toBeGreaterThan(0);
  });

  it("moving both hands together orbits via XZ / YZ", () => {
    const mapper = new GestureMapper();
    step(mapper, 0.3, 0.5, 0.7, 0.5);
    const frame = step(mapper, 0.32, 0.52, 0.72, 0.52);
    expect(frame.increments.XZ).toBeGreaterThan(0);
    expect(frame.increments.YZ).toBeGreaterThan(0);
    expect(frame.increments.ZW).toBeCloseTo(0, 8);
  });

  it("a tracking teleport is capped at maxStepRadians", () => {
    const mapper = new GestureMapper({ rateSmoothingAlpha: 1 });
    step(mapper, 0.45, 0.5, 0.55, 0.5);
    const frame = step(mapper, 0.05, 0.5, 0.95, 0.5); // impossible jump
    expect(Math.abs(frame.increments.ZW)).toBeLessThanOrEqual(
      DEFAULT_GESTURE_OPTIONS.maxStepRadians
    );
  });

  it("holding still decays the smoothed rate toward zero", () => {
    const mapper = new GestureMapper();
    step(mapper, 0.3, 0.5, 0.7, 0.5);
    step(mapper, 0.28, 0.5, 0.72, 0.5);
    let last = Infinity;
    for (let i = 0; i < 30; i += 1) {
      const frame = step(mapper, 0.28, 0.5, 0.72, 0.5);
      expect(Math.abs(frame.increments.ZW)).toBeLessThanOrEqual(last + 1e-12);
      last = Math.abs(frame.increments.ZW);
    }
    expect(last).toBeLessThan(1e-4);
  });
});

describe("inertia (the throw)", () => {
  /** Engage and pull for a few frames so there is real velocity to throw. */
  function spinUp(mapper: GestureMapper): void {
    step(mapper, 0.4, 0.5, 0.6, 0.5);
    for (let i = 1; i <= 5; i += 1) {
      step(mapper, 0.4 - i * 0.01, 0.5, 0.6 + i * 0.01, 0.5);
    }
  }

  function release(mapper: GestureMapper) {
    return mapper.update(hand(0.35, 0.5, false), hand(0.65, 0.5, false), DT);
  }

  it("releasing mid-motion keeps the rotation going", () => {
    const mapper = new GestureMapper();
    spinUp(mapper);
    const frame = release(mapper);
    expect(frame.engaged).toBe(false);
    expect(frame.spinning).toBe(true);
    expect(frame.increments.ZW).toBeGreaterThan(0);
  });

  it("friction decays the free spin toward zero", () => {
    const mapper = new GestureMapper({ spinFriction: 0.9 });
    spinUp(mapper);
    let previous = Infinity;
    for (let i = 0; i < 480; i += 1) {
      const frame = release(mapper);
      expect(Math.abs(frame.increments.ZW)).toBeLessThanOrEqual(previous + 1e-12);
      previous = Math.abs(frame.increments.ZW);
    }
    expect(previous).toBe(0);
  });

  it("zero friction spins forever at constant rate", () => {
    const mapper = new GestureMapper({ spinFriction: 0 });
    spinUp(mapper);
    const first = release(mapper).increments.ZW;
    let last = first;
    for (let i = 0; i < 600; i += 1) last = release(mapper).increments.ZW;
    expect(first).toBeGreaterThan(0);
    expect(last).toBeCloseTo(first, 10);
  });

  it("re-gripping stops the free spin dead (catching the globe)", () => {
    const mapper = new GestureMapper({ spinFriction: 0 });
    spinUp(mapper);
    expect(release(mapper).spinning).toBe(true);
    // Grab: both hands pinch again, held still.
    const grab = step(mapper, 0.35, 0.5, 0.65, 0.5);
    expect(grab.spinning).toBe(false);
    expectAllZero(grab.increments);
    // And letting go from stillness does not resurrect the old spin.
    const after = release(mapper);
    expect(after.spinning).toBe(false);
    expectAllZero(after.increments);
  });

  it("releasing while stationary does not spin", () => {
    const mapper = new GestureMapper();
    step(mapper, 0.4, 0.5, 0.6, 0.5);
    for (let i = 0; i < 30; i += 1) step(mapper, 0.4, 0.5, 0.6, 0.5); // hold still
    const frame = release(mapper);
    expect(frame.spinning).toBe(false);
    expectAllZero(frame.increments);
  });

  it("inertia off restores the hard-stop clutch", () => {
    const mapper = new GestureMapper({ inertia: false });
    spinUp(mapper);
    const frame = release(mapper);
    expect(frame.spinning).toBe(false);
    expectAllZero(frame.increments);
  });
});

describe("wrapAngle", () => {
  it("wraps into (-PI, PI]", () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(2 * Math.PI + 0.1)).toBeCloseTo(0.1, 12);
    expect(wrapAngle(-2 * Math.PI - 0.1)).toBeCloseTo(-0.1, 12);
  });
});
