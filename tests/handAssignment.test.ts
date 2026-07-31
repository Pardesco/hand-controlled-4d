import { describe, expect, it } from "vitest";
import { assignHands, hasBothHands, NO_HANDS, selectPair } from "../src/handAssignment.ts";
import type { AssignedHands, Handedness, TrackedHand } from "../src/types.ts";

function hand(
  handedness: Handedness,
  x: number,
  y: number,
  confidence = 0.95,
  span = 0.12
): TrackedHand {
  const p = { x, y };
  return {
    handedness,
    confidence,
    indexTip: { x, y: y - 0.1 },
    thumbTip: { x: x - 0.03, y: y - 0.05 },
    wrist: { x, y: y + 0.1 },
    palmCenter: p,
    span,
    landmarks: [],
  };
}

describe("assignHands", () => {
  it("returns empty slots when nothing is detected", () => {
    const result = assignHands([], NO_HANDS);
    expect(result).toEqual({ left: null, right: null });
    expect(hasBothHands(result)).toBe(false);
  });

  it("respects confident handedness labels on the first frame", () => {
    const left = hand("Left", 0.3, 0.5);
    const right = hand("Right", 0.7, 0.5);
    const result = assignHands([right, left], NO_HANDS);
    expect(result.left).toBe(left);
    expect(result.right).toBe(right);
  });

  it("is unaffected by detector array order", () => {
    const left = hand("Left", 0.3, 0.5);
    const right = hand("Right", 0.7, 0.5);
    const forward = assignHands([left, right], NO_HANDS);
    const reversed = assignHands([right, left], NO_HANDS);
    expect(reversed.left).toBe(forward.left);
    expect(reversed.right).toBe(forward.right);
  });

  it("keeps slot identity when the detector reverses its order mid-stream", () => {
    const previous: AssignedHands = {
      left: hand("Left", 0.30, 0.5),
      right: hand("Right", 0.70, 0.5),
    };
    const nowLeft = hand("Left", 0.32, 0.5);
    const nowRight = hand("Right", 0.68, 0.5);
    const result = assignHands([nowRight, nowLeft], previous);
    expect(result.left).toBe(nowLeft);
    expect(result.right).toBe(nowRight);
  });

  it("resolves a one-frame label flicker by nearest previous palm centre", () => {
    const previous: AssignedHands = {
      left: hand("Left", 0.30, 0.5),
      right: hand("Right", 0.70, 0.5),
    };
    // Both detections momentarily labelled "Right" -> labels unusable.
    const nearLeftSlot = hand("Right", 0.31, 0.5);
    const nearRightSlot = hand("Right", 0.69, 0.5);
    const result = assignHands([nearRightSlot, nearLeftSlot], previous);
    expect(result.left).toBe(nearLeftSlot);
    expect(result.right).toBe(nearRightSlot);
  });

  it("does not swap slots when a label flips but the hand has barely moved", () => {
    const previous: AssignedHands = {
      left: hand("Left", 0.30, 0.5),
      right: hand("Right", 0.70, 0.5),
    };
    // Left slot's hand is suddenly labelled "Right" and vice versa, with the
    // labels' implied assignment demanding a full-frame teleport.
    const stillLeft = hand("Right", 0.30, 0.5);
    const stillRight = hand("Left", 0.70, 0.5);
    const result = assignHands([stillLeft, stillRight], previous);
    expect(result.left).toBe(stillLeft);
    expect(result.right).toBe(stillRight);
  });

  it("follows hands that genuinely cross over", () => {
    // Different heights so the two hands never occupy the same point, which is
    // the only genuinely ambiguous case for nearest-neighbour matching.
    let state = assignHands([hand("Left", 0.30, 0.4), hand("Right", 0.70, 0.6)], NO_HANDS);
    // Walk them past each other in small, trackable steps.
    for (let i = 1; i <= 10; i += 1) {
      const t = i / 10;
      const a = hand("Left", 0.3 + 0.4 * t, 0.4, 0.4); // low confidence, labels unusable
      const b = hand("Right", 0.7 - 0.4 * t, 0.6, 0.4);
      state = assignHands([b, a], state);
    }
    expect(state.left?.palmCenter.x).toBeCloseTo(0.7);
    expect(state.right?.palmCenter.x).toBeCloseTo(0.3);
  });

  it("puts a single hand back into the slot it left", () => {
    const previous: AssignedHands = {
      left: hand("Left", 0.30, 0.5),
      right: hand("Right", 0.70, 0.5),
    };
    const only = hand("Right", 0.32, 0.5, 0.4);
    const result = assignHands([only], previous);
    expect(result.left).toBe(only);
    expect(result.right).toBeNull();
    expect(hasBothHands(result)).toBe(false);
  });

  it("falls back to the label for a single hand with no usable history", () => {
    const only = hand("Right", 0.7, 0.5);
    const result = assignHands([only], NO_HANDS);
    expect(result.right).toBe(only);
    expect(result.left).toBeNull();
  });

  it("ignores extra ghost detections beyond the two most confident", () => {
    const strongA = hand("Left", 0.3, 0.5, 0.99);
    const strongB = hand("Right", 0.7, 0.5, 0.98);
    const ghost = hand("Right", 0.5, 0.1, 0.2);
    const result = assignHands([ghost, strongA, strongB], NO_HANDS);
    expect(result.left).toBe(strongA);
    expect(result.right).toBe(strongB);
  });

  it("picks the nearer person's pair when a bystander is also in frame", () => {
    // Subject at the lens: big hands. Bystander further back: visibly smaller.
    const subjectLeft = hand("Left", 0.35, 0.5, 0.9, 0.14);
    const subjectRight = hand("Right", 0.62, 0.5, 0.9, 0.135);
    const bystanderLeft = hand("Left", 0.8, 0.35, 0.9, 0.07);
    const bystanderRight = hand("Right", 0.9, 0.35, 0.9, 0.068);

    const chosen = selectPair(
      [bystanderLeft, subjectRight, bystanderRight, subjectLeft],
      NO_HANDS
    );
    expect(chosen).toHaveLength(2);
    expect(chosen).toContain(subjectLeft);
    expect(chosen).toContain(subjectRight);
  });

  it("keeps tracking the same person when a bystander walks through", () => {
    let state: AssignedHands = {
      left: hand("Left", 0.35, 0.5, 0.9, 0.14),
      right: hand("Right", 0.62, 0.5, 0.9, 0.135),
    };
    // The bystander crosses the frame, at times more confident than the subject.
    for (let i = 0; i <= 10; i += 1) {
      const t = i / 10;
      const subjectLeft = hand("Left", 0.35, 0.5, 0.85, 0.14);
      const subjectRight = hand("Right", 0.62, 0.5, 0.85, 0.135);
      const passerLeft = hand("Left", 0.1 + 0.8 * t, 0.3, 0.99, 0.13);
      const passerRight = hand("Right", 0.2 + 0.8 * t, 0.3, 0.99, 0.13);
      state = assignHands([passerLeft, subjectRight, passerRight, subjectLeft], state);
      expect(state.left?.palmCenter.x).toBeCloseTo(0.35);
      expect(state.right?.palmCenter.x).toBeCloseTo(0.62);
    }
  });

  it("prefers one Left and one Right over two of the same label", () => {
    const chosen = selectPair(
      [
        hand("Right", 0.3, 0.5, 0.9),
        hand("Right", 0.5, 0.5, 0.9),
        hand("Left", 0.7, 0.5, 0.9),
      ],
      NO_HANDS
    );
    const labels = chosen.map((h) => h.handedness).sort();
    expect(labels).toEqual(["Left", "Right"]);
  });

  it("passes through unchanged when two or fewer hands are in frame", () => {
    const a = hand("Left", 0.3, 0.5);
    const b = hand("Right", 0.7, 0.5);
    expect(selectPair([a, b], NO_HANDS)).toEqual([a, b]);
    expect(selectPair([a], NO_HANDS)).toEqual([a]);
    expect(selectPair([], NO_HANDS)).toEqual([]);
  });

  it("reports both hands only when both slots are filled", () => {
    const result = assignHands([hand("Left", 0.3, 0.5)], NO_HANDS);
    expect(hasBothHands(result)).toBe(false);
  });
});
