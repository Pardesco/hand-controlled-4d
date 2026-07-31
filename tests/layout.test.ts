import { describe, expect, it } from "vitest";
import {
  computeFrameSize,
  isOutputAspect,
  OUTPUT_ASPECTS,
  type OutputAspect,
} from "../src/layout.ts";

describe("computeFrameSize", () => {
  it("returns the window itself when no aspect is forced", () => {
    expect(computeFrameSize(1920, 1080, null)).toEqual({ width: 1920, height: 1080 });
  });

  it("fits a vertical frame by height in a landscape window", () => {
    const frame = computeFrameSize(1920, 1080, 9 / 16);
    expect(frame.height).toBe(1080);
    expect(frame.width).toBe(Math.floor(1080 * (9 / 16)));
    expect(frame.width).toBeLessThan(1920);
  });

  it("fits a wide frame by width in a portrait window", () => {
    const frame = computeFrameSize(800, 1400, 16 / 9);
    expect(frame.width).toBe(800);
    expect(frame.height).toBe(Math.floor(800 / (16 / 9)));
  });

  it("never overflows the window on either axis", () => {
    for (const key of Object.keys(OUTPUT_ASPECTS) as OutputAspect[]) {
      for (const [w, h] of [
        [1920, 1080],
        [800, 1400],
        [1000, 1000],
        [2560, 1271],
      ] as Array<[number, number]>) {
        const frame = computeFrameSize(w, h, OUTPUT_ASPECTS[key]);
        expect(frame.width).toBeLessThanOrEqual(w);
        expect(frame.height).toBeLessThanOrEqual(h);
      }
    }
  });

  it("produces the requested aspect ratio", () => {
    const frame = computeFrameSize(1920, 1080, 1);
    expect(frame.width / frame.height).toBeCloseTo(1, 2);
    const vertical = computeFrameSize(1920, 1080, 9 / 16);
    expect(vertical.width / vertical.height).toBeCloseTo(9 / 16, 2);
  });

  it("returns whole, non-zero pixels for degenerate input", () => {
    for (const frame of [
      computeFrameSize(0, 0, 9 / 16),
      computeFrameSize(Number.NaN, 1080, 1),
      computeFrameSize(1920, 1080, 0),
      computeFrameSize(1920, 1080, Number.NaN),
      computeFrameSize(1, 1, 16 / 9),
    ]) {
      expect(Number.isInteger(frame.width)).toBe(true);
      expect(Number.isInteger(frame.height)).toBe(true);
      expect(frame.width).toBeGreaterThan(0);
      expect(frame.height).toBeGreaterThan(0);
    }
  });
});

describe("isOutputAspect", () => {
  it("accepts every shipped aspect and rejects anything else", () => {
    for (const key of Object.keys(OUTPUT_ASPECTS)) expect(isOutputAspect(key)).toBe(true);
    expect(isOutputAspect("21:9")).toBe(false);
    expect(isOutputAspect("")).toBe(false);
    expect(isOutputAspect("toString")).toBe(false);
  });
});
