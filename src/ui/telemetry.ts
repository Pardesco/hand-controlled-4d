/**
 * SystemTelemetry — engineering readouts. Diagnostic mode only (DESIGN.md §6).
 *
 * Everything here used to be painted into the composite canvas by
 * `debugOverlay.ts`, which meant normal mode looked like a debug tool and the
 * numbers were baked into recordings. They live in the DOM now; the overlay
 * canvas keeps only the landmark cloud, which is the one thing that genuinely
 * has to be drawn in display space to prove the coordinate contract.
 */

import type { InstrumentState } from "./state.ts";

type Line = { value: HTMLElement; last: string };

export type SystemTelemetry = {
  readonly el: HTMLElement;
  update(state: InstrumentState): void;
};

export function systemTelemetry(): SystemTelemetry {
  const root = document.createElement("section");
  root.className = "panel panel--telemetry";

  const heading = document.createElement("h2");
  heading.className = "panel__heading";
  heading.textContent = "Telemetry";
  root.append(heading);

  const list = document.createElement("dl");
  list.className = "telemetry";
  root.append(list);

  const lines = new Map<string, Line>();
  const addLine = (key: string, label: string): void => {
    const name = document.createElement("dt");
    name.className = "telemetry__label";
    name.textContent = label;
    const value = document.createElement("dd");
    value.className = "telemetry__value";
    value.textContent = "—";
    list.append(name, value);
    lines.set(key, { value, last: "" });
  };

  addLine("renderFps", "render");
  addLine("trackingFps", "tracking");
  addLine("hands", "hands");
  addLine("resolution", "buffer");
  addLine("camera", "source");
  addLine("pinch", "pinch e/r");
  addLine("conf", "det/trk conf");
  addLine("mode", "control");

  const set = (key: string, text: string): void => {
    const line = lines.get(key);
    if (!line || line.last === text) return;
    line.last = text;
    line.value.textContent = text;
  };

  return {
    el: root,
    update(state) {
      set("renderFps", `${state.renderFps.toFixed(0)} fps`);
      set("trackingFps", state.trackingFps > 0 ? `${state.trackingFps.toFixed(0)} fps` : "—");
      set("hands", `${state.handsDetected}/2 of ${state.handsInFrame}`);
      set("resolution", state.resolution);
      set("camera", state.camera);
      set("pinch", `${state.pinchEngage.toFixed(2)} / ${state.pinchRelease.toFixed(2)}`);
      set(
        "conf",
        `${state.detectionConfidence.toFixed(2)} / ${state.trackingConfidence.toFixed(2)}`
      );
      set("mode", state.controlMode);
    },
  };
}
