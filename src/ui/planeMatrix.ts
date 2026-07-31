/**
 * RotationPlaneMatrix — the six planes of SO(4), each in exactly one of five
 * states, drawn as technical axis-pair glyphs rather than as text in a
 * dropdown (DESIGN.md §9).
 *
 * It is also the keyboard fallback for plane selection: each cell is a toggle
 * button, so the instrument is fully operable with no hands in frame. Latching
 * a cell here feeds `KeyboardDrive`, never the gesture pipeline.
 */

import type { RotationPlane } from "../polytope4d.ts";
import {
  PLANE_INFO,
  PLANE_ORDER,
  PLANE_STATE_GLYPH,
  PLANE_STATE_WORD,
  type InstrumentState,
  type PlaneCellState,
} from "./state.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

/**
 * A drafting-notation glyph: two perpendicular axes with the plane's own two
 * letters at their ends, and a quarter-arc showing the sense of rotation.
 */
function axisGlyph(axes: [string, string]): SVGSVGElement {
  const root = svg("svg", { viewBox: "0 0 32 32", class: "plane__glyph", "aria-hidden": "true" });
  // Horizontal and vertical axes.
  root.append(
    svg("line", { x1: "4", y1: "24", x2: "28", y2: "24", class: "plane__axis" }),
    svg("line", { x1: "8", y1: "28", x2: "8", y2: "4", class: "plane__axis" }),
    // Quarter arc from the horizontal toward the vertical: the rotation sense.
    svg("path", { d: "M22 24 A14 14 0 0 0 8 10", class: "plane__arc" })
  );
  const first = svg("text", { x: "30", y: "24", class: "plane__axis-label", "text-anchor": "end" });
  first.textContent = axes[0];
  const second = svg("text", { x: "8", y: "8", class: "plane__axis-label", "text-anchor": "middle" });
  second.textContent = axes[1];
  root.append(first, second);
  return root;
}

type Cell = {
  button: HTMLButtonElement;
  glyphState: HTMLElement;
  bar: HTMLElement;
  latchMark: HTMLElement;
  state: PlaneCellState | null;
  velocity: number;
  latched: boolean;
};

export type RotationPlaneMatrix = {
  readonly el: HTMLElement;
  update(state: InstrumentState, latched: ReadonlySet<RotationPlane>): void;
  /** Move focus into the matrix — used by the keyboard shortcut sheet. */
  focus(): void;
};

export function rotationPlaneMatrix(config: {
  onLatch(plane: RotationPlane, latched: boolean): void;
}): RotationPlaneMatrix {
  const root = document.createElement("section");
  root.className = "panel panel--planes";

  const heading = document.createElement("h2");
  heading.className = "panel__heading";
  heading.textContent = "Rotation planes";
  root.append(heading);

  const grid = document.createElement("div");
  grid.className = "plane-grid";
  grid.setAttribute("role", "group");
  grid.setAttribute("aria-label", "Rotation plane selection");
  root.append(grid);

  const cells = new Map<RotationPlane, Cell>();

  for (const plane of PLANE_ORDER) {
    const info = PLANE_INFO[plane];
    const button = document.createElement("button");
    button.type = "button";
    button.className = "plane";
    button.style.setProperty("--plane-color", `var(${info.colorVar})`);
    button.setAttribute("aria-pressed", "false");
    button.dataset.plane = plane;

    const glyph = axisGlyph(info.axes);

    const name = document.createElement("span");
    name.className = "plane__name";
    name.textContent = plane;

    const glyphState = document.createElement("span");
    glyphState.className = "plane__state";
    glyphState.setAttribute("aria-hidden", "true");

    const finger = document.createElement("span");
    finger.className = "plane__finger";
    finger.textContent = info.finger ?? "orbit";

    const track = document.createElement("span");
    track.className = "plane__track";
    const bar = document.createElement("span");
    bar.className = "plane__bar";
    track.append(bar);

    const latchMark = document.createElement("span");
    latchMark.className = "plane__latch";
    latchMark.textContent = "KEY";
    // Only shown once a plane is latched from the keyboard.
    latchMark.hidden = true;

    button.append(glyph, name, glyphState, finger, track, latchMark);
    grid.append(button);

    const cell: Cell = {
      button,
      glyphState,
      bar,
      latchMark,
      state: null,
      velocity: Number.NaN,
      latched: false,
    };
    cells.set(plane, cell);

    if (!info.selectable) {
      button.disabled = true;
      button.title = `${plane} — reachable through view orbit only, not by a thumb tap`;
    } else {
      button.addEventListener("click", () => {
        config.onLatch(plane, !cell.latched);
      });
    }

    // Arrow keys walk the grid; the roving stop stays on whichever cell was
    // last focused, so Tab always lands somewhere predictable.
    button.addEventListener("keydown", (event) => {
      const order = PLANE_ORDER;
      const index = order.indexOf(plane);
      let delta = 0;
      if (event.key === "ArrowRight") delta = 1;
      else if (event.key === "ArrowLeft") delta = -1;
      else if (event.key === "ArrowDown") delta = 2;
      else if (event.key === "ArrowUp") delta = -2;
      else return;
      event.preventDefault();
      const next = order[(index + delta + order.length) % order.length]!;
      cells.get(next)?.button.focus();
    });
  }

  const paintCell = (
    cell: Cell,
    plane: RotationPlane,
    state: PlaneCellState,
    velocity: number,
    latched: boolean,
    maxSpeed: number
  ): void => {
    if (cell.state !== state) {
      cell.state = state;
      cell.button.dataset.state = state;
      cell.glyphState.textContent = PLANE_STATE_GLYPH[state];
      // Colour is never the only cue: the accessible name carries the word.
      cell.button.setAttribute("aria-label", `${plane} plane — ${PLANE_STATE_WORD[state]}`);
    }
    if (cell.latched !== latched) {
      cell.latched = latched;
      cell.button.setAttribute("aria-pressed", latched ? "true" : "false");
      cell.latchMark.hidden = !latched;
    }
    // Velocity bar: signed, scaled to the active speed cap.
    const extent = Math.max(-1, Math.min(1, velocity / (maxSpeed || 1)));
    const rounded = Math.round(extent * 100) / 100;
    if (cell.velocity !== rounded) {
      cell.velocity = rounded;
      cell.bar.style.setProperty("--bar-extent", `${Math.abs(rounded) * 50}%`);
      cell.bar.dataset.sign = rounded < 0 ? "neg" : "pos";
    }
  };

  return {
    el: root,
    update(state, latched) {
      for (const plane of PLANE_ORDER) {
        const cell = cells.get(plane);
        if (!cell) continue;
        paintCell(
          cell,
          plane,
          state.planes[plane],
          state.velocities[plane],
          latched.has(plane),
          state.maxSpeed
        );
      }
    },
    focus() {
      cells.get(PLANE_ORDER[0]!)?.button.focus();
    },
  };
}
