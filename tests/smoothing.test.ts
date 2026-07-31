import { describe, expect, it } from "vitest";
import {
  clamp,
  dampTowards,
  frameRateAdjustedAlpha,
  REFERENCE_DT,
  Vec2Smoother,
} from "../src/smoothing.ts";

describe("Vec2Smoother", () => {
  it("adopts the first measurement verbatim", () => {
    const s = new Vec2Smoother(0.2);
    expect(s.initialized).toBe(false);
    expect(s.update({ x: 0.4, y: 0.6 })).toEqual({ x: 0.4, y: 0.6 });
    expect(s.initialized).toBe(true);
  });

  it("converges toward a constant input", () => {
    const s = new Vec2Smoother(0.3);
    s.update({ x: 0, y: 0 });
    let out = { x: 0, y: 0 };
    for (let i = 0; i < 200; i += 1) out = s.update({ x: 1, y: -1 });
    expect(out.x).toBeCloseTo(1, 6);
    expect(out.y).toBeCloseTo(-1, 6);
  });

  it("moves more slowly with a lower alpha", () => {
    const slow = new Vec2Smoother(0.1);
    const fast = new Vec2Smoother(0.5);
    slow.update({ x: 0, y: 0 });
    fast.update({ x: 0, y: 0 });
    const target = { x: 1, y: 1 };
    for (let i = 0; i < 5; i += 1) {
      slow.update(target);
      fast.update(target);
    }
    expect(slow.current!.x).toBeLessThan(fast.current!.x);
    expect(slow.current!.x).toBeGreaterThan(0);
  });

  it("applies exactly alpha of the error on one reference-length step", () => {
    const s = new Vec2Smoother(0.25);
    s.update({ x: 0, y: 0 });
    const out = s.update({ x: 1, y: 0 }, REFERENCE_DT);
    expect(out.x).toBeCloseTo(0.25, 10);
  });

  it("never produces NaN from a bad landmark", () => {
    const s = new Vec2Smoother(0.4);
    s.update({ x: 0.5, y: 0.5 });
    const out = s.update({ x: Number.NaN, y: Number.POSITIVE_INFINITY });
    expect(Number.isFinite(out.x)).toBe(true);
    expect(Number.isFinite(out.y)).toBe(true);
    expect(out).toEqual({ x: 0.5, y: 0.5 });
  });

  it("returns a finite point when the very first measurement is bad", () => {
    const s = new Vec2Smoother(0.4);
    const out = s.update({ x: Number.NaN, y: 0.5 });
    expect(Number.isFinite(out.x)).toBe(true);
    expect(s.initialized).toBe(false);
  });

  it("reset() re-initializes at the next measurement", () => {
    const s = new Vec2Smoother(0.1);
    s.update({ x: 0, y: 0 });
    s.reset();
    expect(s.initialized).toBe(false);
    expect(s.update({ x: 0.9, y: 0.9 })).toEqual({ x: 0.9, y: 0.9 });
  });

  it("reset(point) seeds the filter at that point", () => {
    const s = new Vec2Smoother(0.1);
    s.reset({ x: 0.25, y: 0.75 });
    expect(s.current).toEqual({ x: 0.25, y: 0.75 });
    const out = s.update({ x: 0.25, y: 0.75 });
    expect(out).toEqual({ x: 0.25, y: 0.75 });
  });

  it("clamps alpha into a usable range", () => {
    const s = new Vec2Smoother(5);
    expect(s.getAlpha()).toBe(1);
    s.setAlpha(-2);
    expect(s.getAlpha()).toBeGreaterThan(0);
    s.setAlpha(Number.NaN);
    expect(Number.isFinite(s.getAlpha())).toBe(true);
  });

  it("does not hand out a mutable reference to its internal state", () => {
    const s = new Vec2Smoother(0.3);
    s.update({ x: 0.5, y: 0.5 });
    const snapshot = s.current!;
    snapshot.x = 99;
    expect(s.current!.x).toBeCloseTo(0.5);
  });
});

describe("frameRateAdjustedAlpha", () => {
  it("is the identity at the reference frame time", () => {
    expect(frameRateAdjustedAlpha(0.3, REFERENCE_DT)).toBeCloseTo(0.3, 10);
  });

  it("moves further over a longer frame", () => {
    expect(frameRateAdjustedAlpha(0.3, REFERENCE_DT * 2)).toBeGreaterThan(0.3);
    expect(frameRateAdjustedAlpha(0.3, REFERENCE_DT / 2)).toBeLessThan(0.3);
  });

  it("gives the same total smoothing at 30 and 60 FPS", () => {
    const at60 = new Vec2Smoother(0.3);
    const at30 = new Vec2Smoother(0.3);
    at60.update({ x: 0, y: 0 });
    at30.update({ x: 0, y: 0 });
    for (let i = 0; i < 60; i += 1) at60.update({ x: 1, y: 0 }, REFERENCE_DT);
    for (let i = 0; i < 30; i += 1) at30.update({ x: 1, y: 0 }, REFERENCE_DT * 2);
    expect(at30.current!.x).toBeCloseTo(at60.current!.x, 6);
  });

  it("stays in [0, 1] for absurd inputs", () => {
    expect(frameRateAdjustedAlpha(0.5, 0)).toBeGreaterThanOrEqual(0);
    expect(frameRateAdjustedAlpha(0.5, Number.NaN)).toBeLessThanOrEqual(1);
    expect(frameRateAdjustedAlpha(1, 10)).toBe(1);
  });
});

describe("dampTowards", () => {
  it("approaches the target and finally reaches it", () => {
    let v = 0;
    for (let i = 0; i < 200; i += 1) v = dampTowards(v, 1, 0.08, 1 / 60);
    expect(v).toBe(1);
  });

  it("covers half the distance in one half-life", () => {
    expect(dampTowards(0, 1, 0.1, 0.1)).toBeCloseTo(0.5, 6);
  });

  it("fades down as well as up", () => {
    expect(dampTowards(1, 0, 0.1, 0.1)).toBeCloseTo(0.5, 6);
  });

  it("snaps to the target for degenerate timing", () => {
    expect(dampTowards(0, 1, 0, 1 / 60)).toBe(1);
    expect(dampTowards(0, 1, 0.1, 0)).toBe(1);
    expect(dampTowards(Number.NaN, 0.5, 0.1, 0.016)).toBe(0.5);
  });
});

describe("clamp", () => {
  it("bounds on both sides and passes through the middle", () => {
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(clamp(2, 0, 1)).toBe(1);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});
