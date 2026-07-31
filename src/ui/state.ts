/**
 * The frame-rate contract between the app loop and the instrument HUD.
 *
 * `app.ts` fills one preallocated `InstrumentState` per frame and hands it to
 * `InstrumentHud.update()`. Nothing here allocates, and every consumer does its
 * own change detection before touching the DOM (DESIGN.md §9).
 */

import type { PlaneAngles, RotationPlane } from "../polytope4d.ts";

export type UiMode = "normal" | "presentation" | "diagnostic";

export const UI_MODES: readonly UiMode[] = ["normal", "presentation", "diagnostic"];

/** Which of the two instrument roles a hand is playing. */
export type HandRole = "drive" | "select";

/** Tracking condition for the whole system, in descending health. */
export type TrackingState = "acquired" | "partial" | "lost" | "disabled";

/** Five mutually exclusive states a rotation plane can be in (DESIGN.md §9). */
export type PlaneCellState =
  | "unavailable"
  | "available"
  | "targeted"
  | "active"
  | "spinning";

export type FingerName = "index" | "middle" | "ring" | "pinky";

export const FINGER_NAMES: readonly FingerName[] = ["index", "middle", "ring", "pinky"];

export type HandRoleState = {
  present: boolean;
  /** 0..1 from the tracker. */
  confidence: number;
  /** Selector: any fingertip in contact. Drive: pedal held. */
  contact: boolean;
  /** Short condition word: OPEN / PINCH / FIST / TAP / — */
  gesture: string;
  /** 0..1 proximity of the closest contact, for the schematic's approach cue. */
  proximity: number;
  /**
   * Per-finger contact for the selector's schematic: 1 = touching the thumb,
   * fractions = approaching. Left at 0 for the drive hand, whose schematic
   * reports pinch and fist instead.
   */
  fingers: Record<FingerName, number>;
};

/** What the motion system is doing right now, as one word. */
export type MotionCondition =
  | "IDLE"
  | "ACCEL"
  | "COAST"
  | "BRAKE"
  | "HOLD"
  | "GRIP"
  | "FROZEN";

export type InstrumentState = {
  mode: UiMode;
  tracking: TrackingState;
  /** Hands occupying an instrument slot, 0..2. */
  handsDetected: number;
  /** Everything the model found, including bystanders. */
  handsInFrame: number;
  drive: HandRoleState;
  select: HandRoleState;
  planes: Record<RotationPlane, PlaneCellState>;
  velocities: PlaneAngles;
  /** Aggregate angular speed, radians/second. */
  speed: number;
  /** Cap in force, for gauge scaling. */
  maxSpeed: number;
  condition: MotionCondition;
  pedal: boolean;
  braking: boolean;
  frozen: boolean;
  controlMode: "instrument" | "grip";
  /** Which screen side the selector hand is on. */
  selectorSlot: "left" | "right";

  renderFps: number;
  trackingFps: number;
  resolution: string;
  camera: string;
  polytope: string;
  projection: string;
  /** Live gesture thresholds, diagnostic only. */
  pinchEngage: number;
  pinchRelease: number;
  detectionConfidence: number;
  trackingConfidence: number;
};

export function createInstrumentState(): InstrumentState {
  return {
    mode: "normal",
    tracking: "lost",
    handsDetected: 0,
    handsInFrame: 0,
    drive: {
      present: false,
      confidence: 0,
      contact: false,
      gesture: "—",
      proximity: 0,
      fingers: { index: 0, middle: 0, ring: 0, pinky: 0 },
    },
    select: {
      present: false,
      confidence: 0,
      contact: false,
      gesture: "—",
      proximity: 0,
      fingers: { index: 0, middle: 0, ring: 0, pinky: 0 },
    },
    planes: {
      XY: "available",
      XZ: "unavailable",
      XW: "available",
      YZ: "unavailable",
      YW: "available",
      ZW: "available",
    },
    velocities: { XY: 0, XZ: 0, XW: 0, YZ: 0, YW: 0, ZW: 0 },
    speed: 0,
    maxSpeed: 3,
    condition: "IDLE",
    pedal: false,
    braking: false,
    frozen: false,
    controlMode: "instrument",
    selectorSlot: "right",
    renderFps: 0,
    trackingFps: 0,
    resolution: "—",
    camera: "—",
    polytope: "—",
    projection: "—",
    pinchEngage: 0,
    pinchRelease: 0,
    detectionConfidence: 0,
    trackingConfidence: 0,
  };
}

/**
 * Per-plane presentation data. The four tap-selectable planes carry the finger
 * that selects them and the colour that finger's dot is drawn in on camera;
 * XZ and YZ are reachable only through the view orbit, so they are deliberately
 * colourless and the matrix says so rather than implying a fifth finger.
 */
export const PLANE_INFO: Record<
  RotationPlane,
  { axes: [string, string]; colorVar: string; finger: string | null; selectable: boolean }
> = {
  ZW: { axes: ["Z", "W"], colorVar: "--plane-zw", finger: "index", selectable: true },
  YW: { axes: ["Y", "W"], colorVar: "--plane-yw", finger: "middle", selectable: true },
  XW: { axes: ["X", "W"], colorVar: "--plane-xw", finger: "ring", selectable: true },
  XY: { axes: ["X", "Y"], colorVar: "--plane-xy", finger: "pinky", selectable: true },
  XZ: { axes: ["X", "Z"], colorVar: "--plane-view", finger: null, selectable: false },
  YZ: { axes: ["Y", "Z"], colorVar: "--plane-view", finger: null, selectable: false },
};

/** Matrix order: the four W-planes first (they are the 4D ones), then the view pair. */
export const PLANE_ORDER: readonly RotationPlane[] = ["ZW", "YW", "XW", "XY", "XZ", "YZ"];

/** State glyph, so a cell's state is legible without colour. */
export const PLANE_STATE_GLYPH: Record<PlaneCellState, string> = {
  unavailable: "×",
  available: "○",
  targeted: "◍",
  active: "●",
  spinning: "◐",
};

export const PLANE_STATE_WORD: Record<PlaneCellState, string> = {
  unavailable: "view orbit only",
  available: "available",
  targeted: "approaching contact",
  active: "active — driving",
  spinning: "coasting",
};
