/**
 * InstrumentHud — everything that reports live state: the two stage bands and
 * the left instrumentation rail (DESIGN.md §5).
 *
 * `app.ts` calls `update()` once per frame with a preallocated state object.
 * Every component below change-detects before writing, so a steady frame costs
 * a handful of comparisons and no DOM work at all. Nothing here ever touches
 * the canvas, the video element or the tracking pipeline.
 */

import type { RotationPlane } from "../polytope4d.ts";
import { gestureStatus } from "./handRole.ts";
import { motionGauge } from "./motionGauge.ts";
import { rotationPlaneMatrix } from "./planeMatrix.ts";
import {
  PLANE_INFO,
  PLANE_ORDER,
  type InstrumentState,
  type TrackingState,
  type UiMode,
} from "./state.ts";
import { systemTelemetry } from "./telemetry.ts";

const TRACKING_WORD: Record<TrackingState, string> = {
  acquired: "TRACKING",
  partial: "ONE HAND",
  lost: "NO HANDS",
  disabled: "NO TRACKER",
};

const TRACKING_LAMP: Record<TrackingState, string> = {
  acquired: "ok",
  partial: "warn",
  lost: "crit",
  disabled: "off",
};

const TRACKING_DETAIL: Record<TrackingState, string> = {
  acquired: "Both hands acquired.",
  partial: "One hand only — the second role is idle.",
  lost: "No hands detected. Hold both hands up, palms toward the camera.",
  disabled: "Hand tracking is unavailable.",
};

/** Milliseconds of stillness before presentation-mode chrome fades out. */
const PRESENTATION_IDLE_MS = 4000;

type Bands = {
  update(state: InstrumentState): void;
};

/**
 * The only UI permitted inside the aperture: two thin bands at the extreme top
 * and bottom edges, clear of the centre band where the face and hands live.
 */
function stageBands(top: HTMLElement, bottom: HTMLElement): Bands {
  // ---- top: tracking condition + active planes
  const lamp = document.createElement("span");
  lamp.className = "lamp lamp--lg";
  lamp.setAttribute("aria-hidden", "true");
  const word = document.createElement("span");
  word.className = "band__word";

  const trackingGroup = document.createElement("div");
  trackingGroup.className = "band__group";
  trackingGroup.setAttribute("role", "status");
  trackingGroup.setAttribute("aria-live", "polite");
  trackingGroup.append(lamp, word);

  const chips = document.createElement("div");
  chips.className = "band__chips";
  chips.setAttribute("aria-label", "Active rotation planes");

  const chipByPlane = new Map<RotationPlane, HTMLElement>();
  for (const plane of PLANE_ORDER) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = plane;
    chip.hidden = true;
    chip.style.setProperty("--chip-color", `var(${PLANE_INFO[plane].colorVar})`);
    chipByPlane.set(plane, chip);
    chips.append(chip);
  }

  const idle = document.createElement("span");
  idle.className = "chip chip--idle";
  idle.textContent = "NO PLANE";
  chips.append(idle);

  top.append(trackingGroup, chips);

  // ---- bottom: what you are looking at
  const geometry = document.createElement("div");
  geometry.className = "band__group";
  const shape = document.createElement("span");
  shape.className = "band__value";
  const sep = document.createElement("span");
  sep.className = "band__sep";
  sep.textContent = "/";
  const projection = document.createElement("span");
  projection.className = "band__value band__value--dim";
  geometry.append(shape, sep, projection);

  const motion = document.createElement("div");
  motion.className = "band__group band__group--end";
  const conditionWord = document.createElement("span");
  conditionWord.className = "band__condition";
  const speedValue = document.createElement("span");
  speedValue.className = "band__value band__value--mono";
  motion.append(conditionWord, speedValue);

  bottom.append(geometry, motion);

  let lastTracking: TrackingState | null = null;
  let lastShape = "";
  let lastProjection = "";
  let lastCondition = "";
  let lastSpeed = -1;
  const lastChip = new Map<RotationPlane, boolean>();

  return {
    update(state) {
      if (lastTracking !== state.tracking) {
        lastTracking = state.tracking;
        lamp.dataset.state = TRACKING_LAMP[state.tracking];
        word.textContent = TRACKING_WORD[state.tracking];
        trackingGroup.dataset.state = state.tracking;
        trackingGroup.setAttribute("aria-label", TRACKING_DETAIL[state.tracking]);
      }

      let anyActive = false;
      for (const plane of PLANE_ORDER) {
        const cell = state.planes[plane];
        const on = cell === "active" || cell === "spinning";
        if (on) anyActive = true;
        if (lastChip.get(plane) === on) continue;
        lastChip.set(plane, on);
        const chip = chipByPlane.get(plane);
        if (chip) chip.hidden = !on;
      }
      // "NO PLANE" shows exactly when no plane chip does.
      if (idle.hidden !== anyActive) idle.hidden = anyActive;

      if (lastShape !== state.polytope) {
        lastShape = state.polytope;
        shape.textContent = state.polytope;
      }
      if (lastProjection !== state.projection) {
        lastProjection = state.projection;
        projection.textContent = state.projection;
      }
      if (lastCondition !== state.condition) {
        lastCondition = state.condition;
        conditionWord.textContent = state.condition;
        motion.dataset.condition = state.condition;
      }
      const rounded = Math.round(state.speed * 100) / 100;
      if (lastSpeed !== rounded) {
        lastSpeed = rounded;
        speedValue.textContent = `${rounded.toFixed(2)} rad/s`;
      }
    },
  };
}

export type InstrumentHud = {
  update(state: InstrumentState): void;
  setMode(mode: UiMode): void;
  /** Planes latched by keyboard, reflected in the matrix. */
  setLatched(latched: ReadonlySet<RotationPlane>): void;
  focusPlanes(): void;
  /** Any user input; resets the presentation-mode idle timer. */
  noteActivity(): void;
  dispose(): void;
};

export function createInstrumentHud(config: {
  rail: HTMLElement;
  bandTop: HTMLElement;
  bandBottom: HTMLElement;
  shell: HTMLElement;
  onLatch(plane: RotationPlane, latched: boolean): void;
}): InstrumentHud {
  const planes = rotationPlaneMatrix({ onLatch: config.onLatch });
  const hands = gestureStatus();
  const motion = motionGauge();
  const telemetry = systemTelemetry();

  config.rail.append(planes.el, hands.el, motion.el, telemetry.el);

  const bands = stageBands(config.bandTop, config.bandBottom);

  let latched: ReadonlySet<RotationPlane> = new Set();
  let mode: UiMode = "normal";
  let idleTimer: number | null = null;

  const clearIdle = (): void => {
    if (idleTimer !== null) window.clearTimeout(idleTimer);
    idleTimer = null;
  };

  /** Presentation chrome decays to nothing after stillness, returns on input. */
  const armIdle = (): void => {
    clearIdle();
    if (mode !== "presentation") return;
    idleTimer = window.setTimeout(() => {
      config.shell.dataset.chrome = "hidden";
    }, PRESENTATION_IDLE_MS);
  };

  return {
    update(state) {
      bands.update(state);
      if (state.mode === "presentation") return; // rails are inert; skip their work
      planes.update(state, latched);
      hands.update(state);
      motion.update(state);
      if (state.mode === "diagnostic") telemetry.update(state);
    },
    setMode(next) {
      mode = next;
      config.shell.dataset.chrome = "shown";
      // `inert` keeps tab order out of a hidden rail entirely.
      config.rail.inert = next === "presentation";
      armIdle();
    },
    setLatched(next) {
      latched = next;
    },
    focusPlanes() {
      planes.focus();
    },
    noteActivity() {
      if (mode !== "presentation") return;
      config.shell.dataset.chrome = "shown";
      armIdle();
    },
    dispose() {
      clearIdle();
    },
  };
}
