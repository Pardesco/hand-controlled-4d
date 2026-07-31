/**
 * GestureStatus / HandRoleIndicator — which hand is playing which role, and
 * what it is doing right now (DESIGN.md §5B).
 *
 * The two instruments are colour-matched to the feedback rings the renderer
 * already draws on camera: the drive hand's ring is cyan, the selector's
 * fingertip legend is drawn in the plane hues. Reading the rail and reading
 * your own hands should teach the same thing.
 */

import { FINGER_NAMES, type HandRoleState, type InstrumentState } from "./state.ts";
import { PLANE_INFO, PLANE_ORDER } from "./state.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

/** Finger → the plane its thumb-tap selects, for the schematic's tip colours. */
const FINGER_PLANE = new Map(
  PLANE_ORDER.filter((plane) => PLANE_INFO[plane].finger).map((plane) => [
    PLANE_INFO[plane].finger as string,
    plane,
  ])
);

type Schematic = {
  root: SVGSVGElement;
  tips: Map<string, SVGCircleElement>;
  thumbTip: SVGCircleElement;
  pinchLink: SVGLineElement;
  palm: SVGRectElement;
};

/**
 * A compact hand schematic: palm, four fingers, thumb. The selector lights the
 * fingertip whose plane is in contact; the drive hand lights the pinch link and
 * fills the palm for a fist.
 */
function handSchematic(mirrored: boolean): Schematic {
  const root = svg("svg", {
    viewBox: "0 0 56 64",
    class: `schematic${mirrored ? " schematic--mirrored" : ""}`,
    "aria-hidden": "true",
  });

  const palm = svg("rect", {
    x: "13",
    y: "34",
    width: "31",
    height: "24",
    rx: "7",
    class: "schematic__palm",
  });
  root.append(palm);

  const tips = new Map<string, SVGCircleElement>();
  const columns: Array<[string, number, number]> = [
    ["index", 18, 12],
    ["middle", 26, 8],
    ["ring", 34, 10],
    ["pinky", 42, 16],
  ];
  for (const [name, x, top] of columns) {
    root.append(
      svg("line", {
        x1: String(x),
        y1: "38",
        x2: String(x),
        y2: String(top + 3),
        class: "schematic__finger",
      })
    );
    const tip = svg("circle", {
      cx: String(x),
      cy: String(top),
      r: "3.4",
      class: "schematic__tip",
    });
    tip.dataset.finger = name;
    tips.set(name, tip);
    root.append(tip);
  }

  // Thumb, angled off the palm.
  root.append(
    svg("line", { x1: "14", y1: "46", x2: "6", y2: "32", class: "schematic__finger" })
  );
  const thumbTip = svg("circle", { cx: "6", cy: "30", r: "3.4", class: "schematic__tip schematic__tip--thumb" });
  root.append(thumbTip);

  // The pinch link is only visible when the drive hand's pedal is engaged.
  const pinchLink = svg("line", {
    x1: "6",
    y1: "30",
    x2: "18",
    y2: "12",
    class: "schematic__pinch",
  });
  root.append(pinchLink);

  return { root, tips, thumbTip, pinchLink, palm };
}

type Instrument = {
  el: HTMLElement;
  lamp: HTMLElement;
  lampWord: HTMLElement;
  confidenceBar: HTMLElement;
  confidenceValue: HTMLElement;
  gesture: HTMLElement;
  side: HTMLElement;
  schematic: Schematic;
  last: {
    present: boolean | null;
    confidence: number;
    gesture: string;
    contact: boolean | null;
    side: string;
    fingers: Record<string, number>;
  };
};

function buildInstrument(role: "drive" | "select", mirrored: boolean): Instrument {
  const el = document.createElement("article");
  el.className = `role role--${role}`;
  el.dataset.present = "false";

  const header = document.createElement("header");
  header.className = "role__header";

  const title = document.createElement("h3");
  title.className = "role__title";
  title.textContent = role === "drive" ? "Drive" : "Select";

  const side = document.createElement("span");
  side.className = "role__side";

  header.append(title, side);

  const lamp = document.createElement("span");
  lamp.className = "lamp";
  lamp.setAttribute("aria-hidden", "true");
  const lampWord = document.createElement("span");
  lampWord.className = "role__lampword";
  lampWord.textContent = "LOST";

  const lampRow = document.createElement("div");
  lampRow.className = "role__lamprow";
  lampRow.setAttribute("role", "status");
  lampRow.append(lamp, lampWord);

  const schematic = handSchematic(mirrored);

  const body = document.createElement("div");
  body.className = "role__body";

  const meters = document.createElement("div");
  meters.className = "role__meters";

  const confidenceLabel = document.createElement("span");
  confidenceLabel.className = "role__metric-label";
  confidenceLabel.textContent = "conf";
  const confidenceTrack = document.createElement("span");
  confidenceTrack.className = "meter";
  const confidenceBar = document.createElement("span");
  confidenceBar.className = "meter__fill";
  confidenceTrack.append(confidenceBar);
  const confidenceValue = document.createElement("span");
  confidenceValue.className = "role__metric-value";
  confidenceValue.textContent = "—";

  const gestureLabel = document.createElement("span");
  gestureLabel.className = "role__metric-label";
  gestureLabel.textContent = "gesture";
  const gesture = document.createElement("span");
  gesture.className = "role__gesture";
  gesture.textContent = "—";

  meters.append(confidenceLabel, confidenceTrack, confidenceValue, gestureLabel, gesture);
  body.append(schematic.root, meters);

  el.append(header, lampRow, body);

  return {
    el,
    lamp,
    lampWord,
    confidenceBar,
    confidenceValue,
    gesture,
    side,
    schematic,
    last: {
      present: null,
      confidence: -1,
      gesture: "",
      contact: null,
      side: "",
      fingers: { index: -1, middle: -1, ring: -1, pinky: -1 },
    },
  };
}

function updateInstrument(
  instrument: Instrument,
  role: "drive" | "select",
  hand: HandRoleState,
  sideWord: string
): void {
  const { last } = instrument;

  if (last.present !== hand.present) {
    last.present = hand.present;
    instrument.el.dataset.present = String(hand.present);
    instrument.lampWord.textContent = hand.present ? "ACQUIRED" : "LOST";
    instrument.lamp.dataset.state = hand.present ? "ok" : "crit";
  }

  const confidence = Math.round(hand.confidence * 100);
  if (last.confidence !== confidence) {
    last.confidence = confidence;
    instrument.confidenceBar.style.setProperty("--meter-fill", `${confidence}%`);
    instrument.confidenceValue.textContent = hand.present ? `${confidence}%` : "—";
  }

  if (last.gesture !== hand.gesture) {
    last.gesture = hand.gesture;
    instrument.gesture.textContent = hand.gesture;
  }

  if (last.contact !== hand.contact) {
    last.contact = hand.contact;
    instrument.el.dataset.contact = String(hand.contact);
  }

  if (last.side !== sideWord) {
    last.side = sideWord;
    instrument.side.textContent = sideWord;
  }

  if (role === "select") {
    for (const finger of FINGER_NAMES) {
      const value = Math.round(hand.fingers[finger] * 20) / 20;
      if (last.fingers[finger] === value) continue;
      last.fingers[finger] = value;
      const tip = instrument.schematic.tips.get(finger);
      if (!tip) continue;
      const plane = FINGER_PLANE.get(finger);
      tip.style.setProperty("--tip-level", String(value));
      if (plane) tip.style.setProperty("--tip-color", `var(${PLANE_INFO[plane].colorVar})`);
    }
  }
}

export type GestureStatus = {
  readonly el: HTMLElement;
  update(state: InstrumentState): void;
};

export function gestureStatus(): GestureStatus {
  const root = document.createElement("section");
  root.className = "panel panel--gesture";

  const heading = document.createElement("h2");
  heading.className = "panel__heading";
  heading.textContent = "Hands";
  root.append(heading);

  // The drive instrument is listed first: it is the one that makes things move.
  const drive = buildInstrument("drive", false);
  const select = buildInstrument("select", true);
  root.append(drive.el, select.el);

  return {
    el: root,
    update(state) {
      // Which physical side each role is on depends on `selectorSlot`, and the
      // mirror. Saying "screen right" is truthful in both cases; saying "right
      // hand" would not be, because handedness labels are unreliable.
      const selectSide = state.selectorSlot === "right" ? "screen right" : "screen left";
      const driveSide = state.selectorSlot === "right" ? "screen left" : "screen right";
      updateInstrument(drive, "drive", state.drive, driveSide);
      updateInstrument(select, "select", state.select, selectSide);
    },
  };
}
