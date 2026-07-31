import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLANE_DRIVE_OPTIONS,
  FINGER_MAP,
  PlaneDriveMapper,
  THUMB_TIP,
} from "../src/planeDrive.ts";
import { PLANES } from "../src/polytope4d.ts";
import type { Point2D, TrackedHand } from "../src/types.ts";

const DT = 1 / 60;
const SPAN = 0.12;

type FingerName = (typeof FINGER_MAP)[number]["name"];

type HandShape = {
  /** Fingertips touching the thumb tip (the selector tap). */
  touching?: FingerName[];
  /** Thumb-index pinch (the pedal). */
  pinched?: boolean;
  /** All four fingertips at their knuckles (the brake). */
  fist?: boolean;
};

/** A synthetic hand posed for the tap / pinch / fist detectors. */
function hand(shape: HandShape = {}): TrackedHand {
  const cx = 0.5;
  const cy = 0.6;
  const landmarks: Point2D[] = [];
  for (let i = 0; i < 21; i += 1) landmarks.push({ x: cx, y: cy + 0.1 });

  const thumbTip: Point2D = { x: cx - 0.07, y: cy + 0.02 };
  landmarks[THUMB_TIP] = thumbTip;

  const mcpXs = { index: cx - 0.045, middle: cx - 0.015, ring: cx + 0.015, pinky: cx + 0.045 };
  for (const finger of FINGER_MAP) {
    const x = mcpXs[finger.name];
    landmarks[finger.mcp] = { x, y: cy };
    if (shape.fist) {
      landmarks[finger.tip] = { x, y: cy - 0.02 }; // at the knuckle: folded
    } else if (shape.touching?.includes(finger.name)) {
      landmarks[finger.tip] = { x: thumbTip.x + 0.01, y: thumbTip.y }; // on the thumb
    } else {
      landmarks[finger.tip] = { x, y: cy - 0.11 }; // extended
    }
  }
  if (shape.pinched && !shape.fist) {
    // Pinch: index tip meets the thumb, other fingers stay extended.
    landmarks[FINGER_MAP[0].tip] = { x: thumbTip.x + 0.01, y: thumbTip.y };
  }
  if (shape.fist) {
    // A fist's thumb rests against the curled index -- it reads as a pinch.
    landmarks[THUMB_TIP] = {
      x: landmarks[FINGER_MAP[0].tip]!.x + 0.01,
      y: landmarks[FINGER_MAP[0].tip]!.y,
    };
  }

  landmarks[0] = { x: cx, y: cy + 0.16 };
  return {
    handedness: "Right",
    confidence: 1,
    indexTip: landmarks[8]!,
    thumbTip: landmarks[THUMB_TIP]!,
    wrist: landmarks[0]!,
    palmCenter: { x: cx, y: cy + 0.08 },
    span: SPAN,
    landmarks,
  };
}

function expectAllZero(increments: Record<string, number>): void {
  for (const plane of PLANES) expect(increments[plane]).toBe(0);
}

/** One frame: selector tapping `touching`, pedal hand pinched or not. */
function drive(mapper: PlaneDriveMapper, touching: FingerName[], pedal: boolean) {
  return mapper.update(hand({ touching }), hand({ pinched: pedal }), DT);
}

describe("tap selection + pedal", () => {
  it("open selector does nothing however long the pedal is held", () => {
    const mapper = new PlaneDriveMapper();
    for (let i = 0; i < 60; i += 1) drive(mapper, [], true);
    const frame = drive(mapper, [], true);
    expect(frame.selecting).toBe(false);
    expect(frame.spinning).toBe(false);
    expectAllZero(frame.increments);
  });

  it("a tap without the pedal selects but does not move (two-hand mode)", () => {
    const mapper = new PlaneDriveMapper();
    for (let i = 0; i < 60; i += 1) drive(mapper, ["index"], false);
    const frame = drive(mapper, ["index"], false);
    expect(frame.selecting).toBe(true);
    expect(frame.touches.index).toBe(true);
    expect(frame.pedal).toBe(false);
    expect(frame.spinning).toBe(false);
  });

  it.each(FINGER_MAP.map((f) => [f.name, f.plane] as const))(
    "pedal + thumb-tap on %s accelerates %s only",
    (name, plane) => {
      const mapper = new PlaneDriveMapper();
      const frame = drive(mapper, [name], true);
      expect(frame.pedal).toBe(true);
      expect(frame.increments[plane]).toBeGreaterThan(0);
      for (const other of PLANES) {
        if (other !== plane) expect(frame.increments[other]).toBe(0);
      }
    }
  );

  it("holding the pedal builds speed over time", () => {
    const mapper = new PlaneDriveMapper();
    const early = drive(mapper, ["index"], true).velocities.ZW;
    for (let i = 0; i < 60; i += 1) drive(mapper, ["index"], true);
    const later = drive(mapper, ["index"], true).velocities.ZW;
    expect(later).toBeGreaterThan(early);
  });

  it("velocity is capped at maxRate", () => {
    const mapper = new PlaneDriveMapper();
    for (let i = 0; i < 600; i += 1) drive(mapper, ["index"], true);
    const frame = drive(mapper, ["index"], true);
    expect(frame.velocities.ZW).toBeLessThanOrEqual(DEFAULT_PLANE_DRIVE_OPTIONS.maxRate);
    expect(frame.velocities.ZW).toBeGreaterThan(DEFAULT_PLANE_DRIVE_OPTIONS.maxRate * 0.9);
  });

  it("releasing the pedal slows the spin down (friction)", () => {
    const mapper = new PlaneDriveMapper();
    for (let i = 0; i < 120; i += 1) drive(mapper, ["index"], true);
    let previous = drive(mapper, ["index"], false).increments.ZW;
    expect(previous).toBeGreaterThan(0);
    for (let i = 0; i < 60; i += 1) {
      const frame = drive(mapper, ["index"], false);
      expect(frame.increments.ZW).toBeLessThanOrEqual(previous + 1e-12);
      previous = frame.increments.ZW;
    }
  });

  it("releasing the tap lets the plane coast", () => {
    const mapper = new PlaneDriveMapper();
    for (let i = 0; i < 120; i += 1) drive(mapper, ["index"], true);
    const frame = drive(mapper, [], false);
    expect(frame.selecting).toBe(false);
    expect(frame.spinning).toBe(true);
    expect(frame.increments.ZW).toBeGreaterThan(0);
  });

  it("switching planes drives the new one while the old coasts", () => {
    const mapper = new PlaneDriveMapper();
    for (let i = 0; i < 120; i += 1) drive(mapper, ["index"], true);
    const zwBefore = drive(mapper, ["middle"], true).velocities.ZW;
    for (let i = 0; i < 30; i += 1) drive(mapper, ["middle"], true);
    const frame = drive(mapper, ["middle"], true);
    expect(frame.velocities.YW).toBeGreaterThan(0);
    expect(frame.velocities.ZW).toBeGreaterThan(0); // still coasting
    expect(frame.velocities.ZW).toBeLessThan(zwBefore); // but decaying
  });

  it("zero friction coasts forever", () => {
    const mapper = new PlaneDriveMapper({ friction: 0 });
    for (let i = 0; i < 120; i += 1) drive(mapper, ["index"], true);
    const first = drive(mapper, [], false).increments.ZW;
    let last = first;
    for (let i = 0; i < 600; i += 1) last = drive(mapper, [], false).increments.ZW;
    expect(first).toBeGreaterThan(0);
    expect(last).toBeCloseTo(first, 10);
  });
});

describe("one-hand fallback (no pedal hand)", () => {
  it("a tap ramps toward the fixed hold rate", () => {
    const mapper = new PlaneDriveMapper();
    for (let i = 0; i < 120; i += 1) {
      mapper.update(hand({ touching: ["index"] }), null, DT);
    }
    const frame = mapper.update(hand({ touching: ["index"] }), null, DT);
    expect(frame.velocities.ZW).toBeGreaterThan(DEFAULT_PLANE_DRIVE_OPTIONS.holdRate * 0.8);
    expect(frame.velocities.ZW).toBeLessThanOrEqual(DEFAULT_PLANE_DRIVE_OPTIONS.holdRate);
  });

  it("still coasts after the tap releases", () => {
    const mapper = new PlaneDriveMapper();
    for (let i = 0; i < 120; i += 1) {
      mapper.update(hand({ touching: ["index"] }), null, DT);
    }
    const frame = mapper.update(hand(), null, DT);
    expect(frame.spinning).toBe(true);
    expect(frame.increments.ZW).toBeGreaterThan(0);
  });
});

describe("brakes", () => {
  function spinUp(mapper: PlaneDriveMapper): void {
    for (let i = 0; i < 120; i += 1) drive(mapper, ["index"], true);
  }

  it("a pedal-hand fist damps everything to zero, even though it reads as a pinch", () => {
    const mapper = new PlaneDriveMapper({ friction: 0 });
    spinUp(mapper);
    let frame = drive(mapper, [], false);
    expect(frame.spinning).toBe(true);
    for (let i = 0; i < 120; i += 1) {
      frame = mapper.update(hand({ touching: ["index"] }), hand({ fist: true }), DT);
      expect(frame.braking).toBe(true);
      expect(frame.pedal).toBe(false);
    }
    expect(frame.spinning).toBe(false);
    expectAllZero(frame.increments);
  });

  it("releasing the fist releases the brake", () => {
    const mapper = new PlaneDriveMapper();
    spinUp(mapper);
    for (let i = 0; i < 30; i += 1) {
      mapper.update(hand(), hand({ fist: true }), DT);
    }
    const frame = drive(mapper, ["index"], true);
    expect(frame.braking).toBe(false);
    expect(frame.pedal).toBe(true);
    expect(frame.increments.ZW).toBeGreaterThan(0);
  });
});

describe("dropouts", () => {
  it("losing the selector hand lets planes coast", () => {
    const mapper = new PlaneDriveMapper({ friction: 0 });
    for (let i = 0; i < 120; i += 1) drive(mapper, ["index"], true);
    const frame = mapper.update(null, hand(), DT);
    expect(frame.selecting).toBe(false);
    expect(frame.spinning).toBe(true);
  });

  it("uses hysteresis between touch and release ratios", () => {
    const mapper = new PlaneDriveMapper();
    // In-between gap: 0.37 of span sits between touch (0.3) and untouch (0.45).
    const between = hand();
    const thumb = between.landmarks[THUMB_TIP]!;
    const index = FINGER_MAP[0];
    between.landmarks[index.tip] = { x: thumb.x + 0.37 * SPAN, y: thumb.y };
    let frame = mapper.update(between, hand({ pinched: true }), DT);
    expect(frame.selecting).toBe(false);
    drive(mapper, ["index"], true);
    frame = mapper.update(between, hand({ pinched: true }), DT);
    expect(frame.selecting).toBe(true);
  });

  it("reset clears touches, pedal and velocities", () => {
    const mapper = new PlaneDriveMapper({ friction: 0 });
    for (let i = 0; i < 120; i += 1) drive(mapper, ["index"], true);
    mapper.reset();
    const frame = drive(mapper, [], false);
    expect(frame.spinning).toBe(false);
    expectAllZero(frame.increments);
  });
});
