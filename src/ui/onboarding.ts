/**
 * CalibrationFlow — the first-run experience (DESIGN.md §13).
 *
 * A corner-docked step card, never a modal, never over the aperture centre.
 * Each step advances on *detected success* rather than on a Next click, because
 * the thing being taught is a gesture and the only proof it landed is the
 * tracker seeing it. Five steps, each under a dozen words.
 */

import type { InstrumentState } from "./state.ts";

type Step = {
  id: string;
  title: string;
  body: string;
  /** Advance when this returns true. Undefined = advance on the timer. */
  done?(state: InstrumentState): boolean;
  /** Highlights a rail component while the step is live. */
  highlight?: string;
};

const STEPS: readonly Step[] = [
  {
    id: "camera",
    title: "Camera live",
    body: "Every frame is processed on this machine and never uploaded.",
  },
  {
    id: "hands",
    title: "Both hands up",
    body: "Palms toward the camera, inside the frame.",
    done: (state) => state.tracking === "acquired",
    highlight: "hands",
  },
  {
    id: "select",
    title: "Select a plane",
    body: "Tap your thumb to a fingertip. Each finger is one 4D plane.",
    done: (state) => state.select.contact,
    highlight: "planes",
  },
  {
    id: "drive",
    title: "Accelerate",
    body: "Other hand: pinch and hold. The selected plane spins up.",
    done: (state) => state.pedal,
    highlight: "motion",
  },
  {
    id: "brake",
    title: "Brake",
    body: "Close that hand into a fist to stop everything.",
    done: (state) => state.braking,
    highlight: "motion",
  },
];

/** How long a step with no detectable success stays up. */
const AUTO_MS = 3200;
/** Beat between a step being satisfied and the next appearing. */
const ADVANCE_MS = 700;

export type CalibrationFlow = {
  readonly el: HTMLElement;
  start(): void;
  update(state: InstrumentState): void;
  stop(): void;
  readonly running: boolean;
};

export function calibrationFlow(config: {
  onFinish(completed: boolean): void;
  onHighlight(target: string | null): void;
}): CalibrationFlow {
  const root = document.createElement("aside");
  root.className = "calibration";
  root.hidden = true;
  root.setAttribute("aria-label", "Getting started");

  const progress = document.createElement("ol");
  progress.className = "calibration__progress";
  const dots = STEPS.map((step, index) => {
    const dot = document.createElement("li");
    dot.className = "calibration__dot";
    dot.textContent = String(index + 1);
    dot.title = step.title;
    progress.append(dot);
    return dot;
  });

  const title = document.createElement("h2");
  title.className = "calibration__title";
  const body = document.createElement("p");
  body.className = "calibration__body";

  const status = document.createElement("p");
  status.className = "calibration__status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const actions = document.createElement("div");
  actions.className = "calibration__actions";
  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "action";
  skip.textContent = "Skip";
  const next = document.createElement("button");
  next.type = "button";
  next.className = "action action--primary";
  next.textContent = "Next";
  actions.append(skip, next);

  root.append(progress, title, body, status, actions);

  let index = -1;
  let running = false;
  let timer: number | null = null;
  let satisfied = false;

  const clearTimer = (): void => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };

  const finish = (completed: boolean): void => {
    clearTimer();
    running = false;
    root.hidden = true;
    config.onHighlight(null);
    config.onFinish(completed);
  };

  const show = (i: number): void => {
    clearTimer();
    satisfied = false;
    index = i;
    if (index >= STEPS.length) {
      finish(true);
      return;
    }
    const step = STEPS[index]!;
    title.textContent = step.title;
    body.textContent = step.body;
    status.textContent = step.done ? "Waiting for you…" : "";
    root.dataset.step = step.id;
    dots.forEach((dot, d) => {
      dot.dataset.state = d < index ? "done" : d === index ? "current" : "todo";
    });
    config.onHighlight(step.highlight ?? null);
    // Steps with nothing to detect advance themselves; the rest wait, but the
    // Next button is always there so nobody is trapped by a bad camera.
    if (!step.done) timer = window.setTimeout(() => show(index + 1), AUTO_MS);
  };

  skip.addEventListener("click", () => finish(false));
  next.addEventListener("click", () => show(index + 1));

  return {
    el: root,
    start() {
      running = true;
      root.hidden = false;
      show(0);
    },
    update(state) {
      if (!running || satisfied || index < 0 || index >= STEPS.length) return;
      const step = STEPS[index]!;
      if (!step.done || !step.done(state)) return;
      satisfied = true;
      status.textContent = "Got it.";
      root.dataset.satisfied = "true";
      timer = window.setTimeout(() => {
        root.dataset.satisfied = "false";
        show(index + 1);
      }, ADVANCE_MS);
    },
    stop() {
      if (running) finish(false);
    },
    get running() {
      return running;
    },
  };
}
