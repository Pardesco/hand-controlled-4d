/**
 * MotionGauge — how fast the polytope is turning, and why (DESIGN.md §5B).
 *
 * The arc is the aggregate angular speed against the active cap. The condition
 * word underneath is the *cause*: ACCEL while the pedal is held, COAST while
 * friction bleeds it off, BRAKE under a fist, HOLD on the one-hand fallback,
 * FROZEN when rotation is suspended. Speed alone cannot distinguish those, and
 * the difference is the whole feel of the instrument.
 */

import type { InstrumentState, MotionCondition } from "./state.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
/** 220° sweep, so the ends read as an instrument dial rather than a pie. */
const SWEEP = 220;
const RADIUS = 34;
const ARC_LENGTH = (SWEEP / 360) * 2 * Math.PI * RADIUS;

function polar(cx: number, cy: number, r: number, degrees: number): [number, number] {
  const rad = ((degrees - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arcPath(cx: number, cy: number, r: number, sweep: number): string {
  const start = -sweep / 2;
  const end = sweep / 2;
  const [x1, y1] = polar(cx, cy, r, start);
  const [x2, y2] = polar(cx, cy, r, end);
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${sweep > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/** Longer word than the token, for the accessible status line. */
const CONDITION_DETAIL: Record<MotionCondition, string> = {
  IDLE: "at rest",
  ACCEL: "accelerating — pedal held",
  COAST: "coasting on friction",
  BRAKE: "braking — fist held",
  HOLD: "one-hand fallback drive",
  GRIP: "driven by grip-and-pull",
  FROZEN: "rotation frozen",
};

export type MotionGauge = {
  readonly el: HTMLElement;
  update(state: InstrumentState): void;
};

export function motionGauge(): MotionGauge {
  const root = document.createElement("section");
  root.className = "panel panel--motion";

  const heading = document.createElement("h2");
  heading.className = "panel__heading";
  heading.textContent = "Motion";
  root.append(heading);

  const dial = document.createElementNS(SVG_NS, "svg");
  dial.setAttribute("viewBox", "0 0 88 66");
  dial.setAttribute("class", "gauge");
  dial.setAttribute("aria-hidden", "true");

  const track = document.createElementNS(SVG_NS, "path");
  track.setAttribute("d", arcPath(44, 40, RADIUS, SWEEP));
  track.setAttribute("class", "gauge__track");

  const fill = document.createElementNS(SVG_NS, "path");
  fill.setAttribute("d", arcPath(44, 40, RADIUS, SWEEP));
  fill.setAttribute("class", "gauge__fill");
  fill.setAttribute("stroke-dasharray", `${ARC_LENGTH.toFixed(2)}`);
  fill.setAttribute("stroke-dashoffset", `${ARC_LENGTH.toFixed(2)}`);

  // Tick marks at quarters, so the dial has a scale rather than just a glow.
  const ticks = document.createElementNS(SVG_NS, "g");
  ticks.setAttribute("class", "gauge__ticks");
  for (let i = 0; i <= 4; i += 1) {
    const angle = -SWEEP / 2 + (SWEEP * i) / 4;
    const [x1, y1] = polar(44, 40, RADIUS - 7, angle);
    const [x2, y2] = polar(44, 40, RADIUS - 3, angle);
    const tick = document.createElementNS(SVG_NS, "line");
    tick.setAttribute("x1", x1.toFixed(2));
    tick.setAttribute("y1", y1.toFixed(2));
    tick.setAttribute("x2", x2.toFixed(2));
    tick.setAttribute("y2", y2.toFixed(2));
    ticks.append(tick);
  }

  dial.append(track, ticks, fill);

  const speed = document.createElement("span");
  speed.className = "gauge__value";
  speed.textContent = "0.00";
  const unit = document.createElement("span");
  unit.className = "gauge__unit";
  unit.textContent = "rad/s";

  const dialWrap = document.createElement("div");
  dialWrap.className = "gauge__wrap";
  dialWrap.append(dial, speed, unit);

  const condition = document.createElement("p");
  condition.className = "condition";
  condition.setAttribute("role", "status");
  condition.setAttribute("aria-live", "polite");

  const conditionWord = document.createElement("span");
  conditionWord.className = "condition__word";
  conditionWord.textContent = "IDLE";
  const conditionDetail = document.createElement("span");
  conditionDetail.className = "condition__detail";
  conditionDetail.textContent = CONDITION_DETAIL.IDLE;
  condition.append(conditionWord, conditionDetail);

  root.append(dialWrap, condition);

  let lastSpeed = -1;
  let lastCondition: MotionCondition | null = null;

  return {
    el: root,
    update(state) {
      const rounded = Math.round(state.speed * 100) / 100;
      if (lastSpeed !== rounded) {
        lastSpeed = rounded;
        const fraction = Math.max(0, Math.min(1, state.maxSpeed > 0 ? rounded / state.maxSpeed : 0));
        fill.setAttribute("stroke-dashoffset", (ARC_LENGTH * (1 - fraction)).toFixed(2));
        speed.textContent = rounded.toFixed(2);
      }
      if (lastCondition !== state.condition) {
        lastCondition = state.condition;
        root.dataset.condition = state.condition;
        conditionWord.textContent = state.condition;
        conditionDetail.textContent = CONDITION_DETAIL[state.condition];
      }
    },
  };
}
