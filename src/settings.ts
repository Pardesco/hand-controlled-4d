/** User-facing settings, their defaults, and localStorage persistence. */

import { isOutputAspect, type OutputAspect } from "./layout.ts";
import { POLYTOPE_NAMES, type PolytopeName } from "./polychora.ts";
import type { ProjectionMode } from "./polytope4d.ts";
import { UI_MODES, type UiMode } from "./ui/state.ts";

export type CapturePreset = "720p" | "1080p";

export const CAPTURE_PRESETS: Record<CapturePreset, { width: number; height: number }> = {
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
};

export type Settings = {
  // Camera
  /** Empty string = let the browser pick. */
  deviceId: string;
  capturePreset: CapturePreset;

  // Tracking
  mirror: boolean;
  swapHandedness: boolean;
  smoothingAlpha: number;
  detectionConfidence: number;
  trackingConfidence: number;
  /**
   * Hands the model reports per frame. Only two ever drive the rotation; the
   * extras exist so the app can choose which two when a bystander is in frame.
   */
  maxHands: number;

  // Polytope
  polytope: PolytopeName;
  projection: ProjectionMode;

  // Gesture
  pinchEngageRatio: number;
  pinchReleaseRatio: number;
  rateSmoothingAlpha: number;
  gainZW: number;
  gainXY: number;
  gainYW: number;
  gainXW: number;
  gainOrbit: number;
  /** Enables the mean-position view orbit (XZ/YZ). Off = steadier reading. */
  orbitEnabled: boolean;
  /** Releasing the grip mid-motion throws the object into a free spin. */
  inertiaEnabled: boolean;
  /** Fraction of free-spin velocity lost per second. 0 = spins forever. */
  spinFriction: number;

  /**
   * Which control scheme drives the rotation. The two fight each other when
   * combined (a selector tap IS a pinch geometrically), so they are modes:
   * `instrument` -- thumb-tap plane selection + pinch pedal (default);
   * `grip`       -- both-hands pinch grip-and-pull with the inertia throw.
   */
  controlMode: "instrument" | "grip";

  // Instrument (selector + pedal)
  /**
   * Which SIDE OF THE SCREEN the selector hand is on. Roles are assigned by
   * position, never by MediaPipe handedness labels (inverted on many
   * webcams). In the default mirrored view, "right" = your right hand.
   */
  selectorSlot: "left" | "right";
  /** Pedal (throttle-hand pinch held) acceleration, radians/second^2. */
  pedalAccel: number;
  /** Cap on any plane's instrument velocity, radians/second. */
  maxRate: number;
  /** Coasting friction for instrument-driven planes. 0 = spins forever. */
  driveFriction: number;
  /** One-hand fallback rate when no throttle hand is in frame, rad/s. */
  holdRate: number;

  // Occlusion
  occlusionEnabled: boolean;
  /** Hull expansion margin, display-normalized. */
  hullMargin: number;
  /** Palm span at the polytope's distance; tune per setup, then leave alone. */
  referenceSpan: number;

  // Look
  tubeRadius: number;
  glowStrength: number;
  chromaSplit: number;
  hueBase: number;
  hueRange: number;
  objectScale: number;
  objectCenterY: number;
  accentColor: string;

  // Output
  outputAspect: OutputAspect;
  maxPixelRatio: number;
  showDebug: boolean;

  // Interface
  /**
   * `normal`       -- dominant viewport, essential state, console on demand;
   * `presentation` -- nearly full-screen artwork, chrome decays;
   * `diagnostic`   -- landmarks, raw confidences, frame rates, thresholds.
   */
  uiMode: UiMode;
  /** The first-run calibration flow only runs until it has been seen once. */
  onboardingDone: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  deviceId: "",
  capturePreset: "720p",

  mirror: true,
  swapHandedness: false,
  smoothingAlpha: 0.35,
  detectionConfidence: 0.5,
  trackingConfidence: 0.5,
  maxHands: 4,

  polytope: "8-cell",
  projection: "perspective",

  pinchEngageRatio: 0.45,
  pinchReleaseRatio: 0.7,
  rateSmoothingAlpha: 0.5,
  gainZW: 4.0,
  gainXY: 1.0,
  gainYW: 2.2,
  gainXW: 1.0,
  gainOrbit: 2.2,
  orbitEnabled: true,
  inertiaEnabled: true,
  spinFriction: 0.15,

  controlMode: "instrument",
  selectorSlot: "right",
  pedalAccel: 2.5,
  maxRate: 3,
  driveFriction: 0.3,
  holdRate: 0.9,

  occlusionEnabled: true,
  hullMargin: 0.02,
  referenceSpan: 0.11,

  tubeRadius: 0.016,
  glowStrength: 0.35,
  chromaSplit: 0.012,
  hueBase: 0.52,
  hueRange: 0.33,
  objectScale: 0.95,
  objectCenterY: 0.38,
  accentColor: "#35e0d6",

  outputAspect: "9:16",
  maxPixelRatio: 1.5,
  showDebug: false,

  uiMode: "normal",
  onboardingDone: false,
};

const STORAGE_KEY = "hand-controlled-4d/settings/v1";

/** Numeric guards so a hand-edited localStorage entry cannot break the render. */
const RANGES: Partial<Record<keyof Settings, [number, number]>> = {
  smoothingAlpha: [0.02, 1],
  detectionConfidence: [0.1, 0.95],
  trackingConfidence: [0.1, 0.95],
  maxHands: [2, 6],
  pinchEngageRatio: [0.1, 0.9],
  pinchReleaseRatio: [0.15, 1.2],
  rateSmoothingAlpha: [0.02, 1],
  gainZW: [0, 20],
  gainXY: [0, 10],
  gainYW: [0, 20],
  gainXW: [0, 10],
  gainOrbit: [0, 20],
  spinFriction: [0, 0.99],
  pedalAccel: [0.1, 10],
  maxRate: [0.2, 8],
  driveFriction: [0, 0.99],
  holdRate: [0.05, 4],
  hullMargin: [0, 0.1],
  referenceSpan: [0.03, 0.3],
  tubeRadius: [0.002, 0.08],
  glowStrength: [0, 1],
  chromaSplit: [0, 0.05],
  hueBase: [0, 1],
  hueRange: [-1, 1],
  objectScale: [0.2, 2.5],
  objectCenterY: [0.1, 0.9],
  maxPixelRatio: [0.5, 3],
};

function isPolytopeName(value: string): value is PolytopeName {
  return (POLYTOPE_NAMES as readonly string[]).includes(value);
}

export function loadSettings(): Settings {
  const settings: Settings = { ...DEFAULT_SETTINGS };
  let stored: unknown;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return settings;
    stored = JSON.parse(raw);
  } catch {
    return settings;
  }
  if (typeof stored !== "object" || stored === null) return settings;

  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
    const value = (stored as Record<string, unknown>)[key];
    const fallback = DEFAULT_SETTINGS[key];
    if (typeof value !== typeof fallback) continue;

    if (typeof value === "number") {
      if (!Number.isFinite(value)) continue;
      const range = RANGES[key];
      const clamped = range ? Math.min(range[1], Math.max(range[0], value)) : value;
      (settings[key] as number) = clamped;
    } else if (typeof value === "string") {
      if (key === "polytope" && !isPolytopeName(value)) continue;
      if (key === "projection" && value !== "perspective" && value !== "stereographic") continue;
      if (key === "selectorSlot" && value !== "left" && value !== "right") continue;
      if (key === "controlMode" && value !== "instrument" && value !== "grip") continue;
      // hasOwn, not `in`: `in` would accept inherited names like "toString".
      if (key === "capturePreset" && !Object.hasOwn(CAPTURE_PRESETS, value)) continue;
      if (key === "uiMode" && !(UI_MODES as readonly string[]).includes(value)) continue;
      if (key === "outputAspect" && !isOutputAspect(value)) continue;
      (settings[key] as string) = value;
    } else if (typeof value === "boolean") {
      (settings[key] as boolean) = value;
    }
  }

  // The release threshold must sit above the engage threshold or the pinch
  // clutch chatters; repair rather than reject.
  if (settings.pinchReleaseRatio <= settings.pinchEngageRatio) {
    settings.pinchReleaseRatio = settings.pinchEngageRatio + 0.1;
  }
  return settings;
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private mode or a full quota: settings simply do not persist.
  }
}

export function clearSettings(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
