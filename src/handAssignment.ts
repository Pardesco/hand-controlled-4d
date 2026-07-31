/**
 * Turns MediaPipe's unordered detection list into two *stable slots*.
 *
 * MediaPipe does not guarantee array order between frames, and its handedness
 * label can flicker for a frame when hands cross or a palm turns over. Because
 * each slot owns its own smoothing history, a slot swap shows up as the portal
 * corners jumping. So: trust the labels when they are confident and plausible,
 * otherwise keep identity by nearest previous palm centre.
 *
 * Note the portal itself is order-independent (it uses min/max of the two
 * fingertips), so this module exists purely for temporal stability.
 */

import type { AssignedHands, Point2D, TrackedHand } from "./types.ts";

export type AssignOptions = {
  /** Handedness below this score is treated as unreliable. */
  confidenceThreshold?: number;
  /**
   * Largest plausible per-frame palm movement, in video-normalized units.
   * A label-implied assignment that would exceed this is rejected as a teleport.
   */
  maxMatchDistance?: number;
  /** Preference for the pair nearest to last frame's pair. */
  continuityWeight?: number;
  /** Penalty for the two hands looking like different sizes (different people). */
  scaleWeight?: number;
  /** Preference for the largest hands in frame, i.e. the person nearest the lens. */
  sizeWeight?: number;
  /** Penalty when both hands carry the same handedness label. */
  sameLabelPenalty?: number;
  /** Preference for more confident detections. */
  confidenceWeight?: number;
};

export const NO_HANDS: AssignedHands = { left: null, right: null };

const DEFAULTS = {
  confidenceThreshold: 0.8,
  maxMatchDistance: 0.3,
  continuityWeight: 5,
  scaleWeight: 1.2,
  sizeWeight: 1,
  sameLabelPenalty: 0.35,
  confidenceWeight: 0.5,
} as const;

function dist2(a: Point2D, b: Point2D): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function dist(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * How unlikely this pair is to be the two hands we should be tracking. Lower
 * is better.
 *
 * With a second person in frame the model reports up to four hands, and simply
 * taking the two most confident flickers between people. The cost blends five
 * signals: staying with whoever we were already tracking, the two hands looking
 * like they belong to one body, those hands being the nearest ones to the lens,
 * one Left plus one Right, and detection confidence.
 *
 * Continuity dominates, which is what stops a bystander walking through frame
 * from stealing the portal. On first acquisition there is no history, so size
 * decides: the person closest to the camera is the one driving it.
 *
 * @param maxSpan largest palm span in frame, the yardstick for "nearest".
 */
function pairCost(
  a: TrackedHand,
  b: TrackedHand,
  previous: AssignedHands,
  maxSpan: number,
  options: Required<Pick<
    AssignOptions,
    | "continuityWeight"
    | "scaleWeight"
    | "sizeWeight"
    | "sameLabelPenalty"
    | "confidenceWeight"
  >>
): number {
  let cost = 0;

  if (previous.left && previous.right) {
    const straight = dist(a.palmCenter, previous.left.palmCenter)
      + dist(b.palmCenter, previous.right.palmCenter);
    const swapped = dist(a.palmCenter, previous.right.palmCenter)
      + dist(b.palmCenter, previous.left.palmCenter);
    cost += Math.min(straight, swapped) * options.continuityWeight;
  }

  // Two hands of one person, at one distance from the lens, measure alike.
  const larger = Math.max(a.span, b.span);
  const smaller = Math.min(a.span, b.span);
  if (larger > 1e-6) cost += (1 - smaller / larger) * options.scaleWeight;

  // ...but matching each other is not enough on its own: a person across the
  // room also has two hands that match. Prefer the biggest hands in frame.
  if (maxSpan > 1e-6) {
    const mean = (a.span + b.span) * 0.5;
    cost += (1 - Math.min(mean / maxSpan, 1)) * options.sizeWeight;
  }

  if (a.handedness === b.handedness) cost += options.sameLabelPenalty;

  cost += (2 - a.confidence - b.confidence) * options.confidenceWeight;
  return cost;
}

/**
 * Reduces however many hands the model found to the two the portal should use.
 * Returns them in detector order; slot assignment happens afterwards.
 */
export function selectPair(
  candidates: readonly TrackedHand[],
  previous: AssignedHands = NO_HANDS,
  options: AssignOptions = {}
): TrackedHand[] {
  if (candidates.length <= 2) return [...candidates];

  const weights = {
    continuityWeight: options.continuityWeight ?? DEFAULTS.continuityWeight,
    scaleWeight: options.scaleWeight ?? DEFAULTS.scaleWeight,
    sizeWeight: options.sizeWeight ?? DEFAULTS.sizeWeight,
    sameLabelPenalty: options.sameLabelPenalty ?? DEFAULTS.sameLabelPenalty,
    confidenceWeight: options.confidenceWeight ?? DEFAULTS.confidenceWeight,
  };

  let maxSpan = 0;
  for (const hand of candidates) maxSpan = Math.max(maxSpan, hand.span);

  let best: TrackedHand[] = [candidates[0]!, candidates[1]!];
  let bestCost = Infinity;
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i]!;
      const b = candidates[j]!;
      const cost = pairCost(a, b, previous, maxSpan, weights);
      if (cost < bestCost) {
        bestCost = cost;
        best = [a, b];
      }
    }
  }
  return best;
}

/**
 * @param candidates Hands from the current frame, any order.
 * @param previous   Last frame's assignment (pass `NO_HANDS` on the first frame).
 */
export function assignHands(
  candidates: readonly TrackedHand[],
  previous: AssignedHands = NO_HANDS,
  options: AssignOptions = {}
): AssignedHands {
  const confidenceThreshold = options.confidenceThreshold ?? DEFAULTS.confidenceThreshold;
  const maxMatchDistance = options.maxMatchDistance ?? DEFAULTS.maxMatchDistance;
  const limit = maxMatchDistance * maxMatchDistance;

  // Reduce to two. With more than two in frame this is a scored choice, not
  // just "the most confident" -- see selectPair().
  const hands = selectPair(candidates, previous, options);

  if (hands.length === 0) return { left: null, right: null };

  if (hands.length === 1) {
    const hand = hands[0]!;
    const dLeft = previous.left ? dist2(hand.palmCenter, previous.left.palmCenter) : Infinity;
    const dRight = previous.right ? dist2(hand.palmCenter, previous.right.palmCenter) : Infinity;
    const nearest = Math.min(dLeft, dRight);

    // No usable history, or the hand is nowhere near where either slot was:
    // fall back to the label.
    if (!Number.isFinite(nearest) || nearest > limit) {
      return hand.handedness === "Left"
        ? { left: hand, right: null }
        : { left: null, right: hand };
    }
    return dLeft <= dRight ? { left: hand, right: null } : { left: null, right: hand };
  }

  const a = hands[0]!;
  const b = hands[1]!;
  const havePrevious = previous.left !== null && previous.right !== null;

  const straight: AssignedHands = { left: a, right: b };
  const swapped: AssignedHands = { left: b, right: a };

  const labelsUsable =
    a.handedness !== b.handedness &&
    a.confidence >= confidenceThreshold &&
    b.confidence >= confidenceThreshold;

  if (labelsUsable) {
    const byLabel = a.handedness === "Left" ? straight : swapped;
    if (!havePrevious) return byLabel;
    // Accept the labels unless they would teleport a slot across the frame.
    const cost = pairingCost(byLabel, previous);
    if (cost <= limit * 2) return byLabel;
  }

  if (havePrevious) {
    return pairingCost(straight, previous) <= pairingCost(swapped, previous) ? straight : swapped;
  }

  // First frame, ambiguous labels: fall back to a deterministic spatial order.
  return a.palmCenter.x <= b.palmCenter.x ? straight : swapped;
}

function pairingCost(candidate: AssignedHands, previous: AssignedHands): number {
  if (!candidate.left || !candidate.right || !previous.left || !previous.right) return Infinity;
  return (
    dist2(candidate.left.palmCenter, previous.left.palmCenter) +
    dist2(candidate.right.palmCenter, previous.right.palmCenter)
  );
}

/** True only when both slots are filled, i.e. a portal can exist. */
export function hasBothHands(hands: AssignedHands): hands is {
  left: TrackedHand;
  right: TrackedHand;
} {
  return hands.left !== null && hands.right !== null;
}
