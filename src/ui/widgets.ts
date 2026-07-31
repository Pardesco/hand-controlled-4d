/**
 * Bespoke control primitives for the instrument console (DESIGN.md §9).
 *
 * The rule these exist to enforce: control form follows data type. A mode is a
 * segmented selector, a bounded continuous value is a slider, a precision
 * threshold is a numeric control, a binary is a toggle. Six identical sliders
 * in a column is the pattern being corrected.
 *
 * All of them are plain DOM. Every one has a real <label for>, a visible focus
 * ring, keyboard operation without a drag, and a hit target of at least 26px.
 */

let uid = 0;
const nextId = (prefix: string): string => `${prefix}-${(uid += 1)}`;

export type ControlHandle<T> = {
  readonly el: HTMLElement;
  /** Push an external value change into the control's display. */
  set(value: T): void;
  setDisabled(disabled: boolean): void;
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Label + control row. Returns the row and the slot the control goes in. */
function field(labelText: string, controlId: string, hint?: string) {
  const row = el("div", "field");
  const label = el("label", "field__label", labelText);
  label.htmlFor = controlId;
  if (hint) label.title = hint;
  const slot = el("div", "field__control");
  row.append(label, slot);
  return { row, slot, label };
}

// --------------------------------------------------------------- segmented

export type SegmentOption<T extends string> = {
  value: T;
  label: string;
  /** Long-form name, used as the accessible description and tooltip. */
  hint?: string;
};

/**
 * Enumerations. A radiogroup, not a dropdown: the available choices are part of
 * the readout, so you can see what mode you are NOT in.
 */
export function segmentedSelector<T extends string>(config: {
  label: string;
  value: T;
  options: readonly SegmentOption<T>[];
  onChange(value: T): void;
  /** Stacks the segments vertically — for long option labels. */
  stacked?: boolean;
  hint?: string;
}): ControlHandle<T> {
  const id = nextId("seg");
  const { row, slot } = field(config.label, id, config.hint);
  const group = el("div", `segmented${config.stacked ? " segmented--stacked" : ""}`);
  group.id = id;
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", config.label);

  let current = config.value;
  const buttons = new Map<T, HTMLButtonElement>();

  const paint = (): void => {
    for (const [value, button] of buttons) {
      const on = value === current;
      button.setAttribute("aria-checked", on ? "true" : "false");
      button.classList.toggle("is-on", on);
      // Roving tabindex: one stop for the whole group.
      button.tabIndex = on ? 0 : -1;
    }
  };

  const move = (delta: number): void => {
    const values = [...buttons.keys()];
    const index = values.indexOf(current);
    const next = values[(index + delta + values.length) % values.length]!;
    current = next;
    paint();
    buttons.get(next)?.focus();
    config.onChange(next);
  };

  for (const option of config.options) {
    const button = el("button", "segmented__item", option.label);
    button.type = "button";
    button.setAttribute("role", "radio");
    if (option.hint) button.title = option.hint;
    button.addEventListener("click", () => {
      if (current === option.value) return;
      current = option.value;
      paint();
      config.onChange(option.value);
    });
    button.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        move(1);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        move(-1);
      }
    });
    buttons.set(option.value, button);
    group.append(button);
  }
  paint();
  slot.append(group);

  return {
    el: row,
    set(value) {
      if (value === current) return;
      current = value;
      paint();
    },
    setDisabled(disabled) {
      row.classList.toggle("is-disabled", disabled);
      for (const button of buttons.values()) button.disabled = disabled;
    },
  };
}

// ------------------------------------------------------------ native select

/** For genuinely open-ended lists (camera devices), where segments do not fit. */
export function selectControl(config: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange(value: string): void;
}): ControlHandle<string> & { setOptions(options: readonly { value: string; label: string }[]): void } {
  const id = nextId("sel");
  const { row, slot } = field(config.label, id);
  const select = el("select", "select");
  select.id = id;

  const fill = (options: readonly { value: string; label: string }[], value: string): void => {
    select.replaceChildren();
    for (const option of options) {
      const node = el("option", undefined, option.label);
      node.value = option.value;
      select.append(node);
    }
    select.value = value;
  };
  fill(config.options, config.value);
  select.addEventListener("change", () => config.onChange(select.value));
  slot.append(select);

  return {
    el: row,
    set(value) {
      select.value = value;
    },
    setOptions(options) {
      fill(options, select.value);
    },
    setDisabled(disabled) {
      row.classList.toggle("is-disabled", disabled);
      select.disabled = disabled;
    },
  };
}

// ------------------------------------------------------------------ slider

const formatValue = (value: number, step: number): string => {
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  return value.toFixed(decimals);
};

/**
 * Bounded continuous values with a felt range. The fill is a CSS custom
 * property so dragging never triggers a layout pass.
 */
export function instrumentSlider(config: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange(value: number): void;
  unit?: string;
  hint?: string;
  /** Tints the fill with a signal colour, e.g. var(--drive). */
  accent?: string;
}): ControlHandle<number> {
  const id = nextId("sld");
  const { row, slot } = field(config.label, id, config.hint);
  row.classList.add("field--slider");

  const wrap = el("div", "slider");
  if (config.accent) wrap.style.setProperty("--slider-accent", config.accent);
  const input = el("input", "slider__input");
  input.type = "range";
  input.id = id;
  input.min = String(config.min);
  input.max = String(config.max);
  input.step = String(config.step);
  input.value = String(config.value);

  const readout = el("output", "slider__value");
  readout.htmlFor = id;

  const paint = (value: number): void => {
    const fraction = (value - config.min) / (config.max - config.min || 1);
    wrap.style.setProperty("--slider-fill", `${Math.max(0, Math.min(1, fraction)) * 100}%`);
    readout.textContent = formatValue(value, config.step) + (config.unit ?? "");
  };
  paint(config.value);

  input.addEventListener("input", () => {
    const value = Number(input.value);
    paint(value);
    config.onChange(value);
  });

  wrap.append(input);
  slot.append(wrap, readout);

  return {
    el: row,
    set(value) {
      input.value = String(value);
      paint(value);
    },
    setDisabled(disabled) {
      row.classList.toggle("is-disabled", disabled);
      input.disabled = disabled;
    },
  };
}

// ----------------------------------------------------------------- numeric

/**
 * Precision values where the exact number matters more than the feel of the
 * range — pinch thresholds, confidences, reference span. Type a value, or
 * step it with the arrow keys / the stepper buttons. No drag required.
 */
export function numericControl(config: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange(value: number): void;
  hint?: string;
}): ControlHandle<number> {
  const id = nextId("num");
  const { row, slot } = field(config.label, id, config.hint);
  row.classList.add("field--numeric");

  const wrap = el("div", "numeric");
  const down = el("button", "numeric__step", "−");
  down.type = "button";
  down.tabIndex = -1;
  down.setAttribute("aria-label", `Decrease ${config.label}`);
  const up = el("button", "numeric__step", "+");
  up.type = "button";
  up.tabIndex = -1;
  up.setAttribute("aria-label", `Increase ${config.label}`);

  const input = el("input", "numeric__input");
  input.type = "number";
  input.id = id;
  input.min = String(config.min);
  input.max = String(config.max);
  input.step = String(config.step);
  input.inputMode = "decimal";
  input.value = formatValue(config.value, config.step);

  const clamp = (value: number): number =>
    Math.min(config.max, Math.max(config.min, value));

  const commit = (value: number): void => {
    const next = clamp(Number.isFinite(value) ? value : config.value);
    input.value = formatValue(next, config.step);
    config.onChange(next);
  };

  input.addEventListener("change", () => commit(Number(input.value)));
  down.addEventListener("click", () => commit(Number(input.value) - config.step));
  up.addEventListener("click", () => commit(Number(input.value) + config.step));

  wrap.append(down, input, up);
  slot.append(wrap);

  return {
    el: row,
    set(value) {
      input.value = formatValue(value, config.step);
    },
    setDisabled(disabled) {
      row.classList.toggle("is-disabled", disabled);
      input.disabled = down.disabled = up.disabled = disabled;
    },
  };
}

// ------------------------------------------------------------------ toggle

/** Binary state. Carries the words ON/OFF so colour is never the only cue. */
export function toggleControl(config: {
  label: string;
  value: boolean;
  onChange(value: boolean): void;
  hint?: string;
  onWord?: string;
  offWord?: string;
}): ControlHandle<boolean> {
  const id = nextId("tgl");
  const { row, slot } = field(config.label, id, config.hint);
  row.classList.add("field--toggle");

  const button = el("button", "toggle");
  button.type = "button";
  button.id = id;
  button.setAttribute("role", "switch");

  const track = el("span", "toggle__track");
  const word = el("span", "toggle__word");
  button.append(track, word);

  let current = config.value;
  const paint = (): void => {
    button.setAttribute("aria-checked", current ? "true" : "false");
    button.classList.toggle("is-on", current);
    word.textContent = current ? (config.onWord ?? "ON") : (config.offWord ?? "OFF");
  };
  paint();

  button.addEventListener("click", () => {
    current = !current;
    paint();
    config.onChange(current);
  });

  slot.append(button);

  return {
    el: row,
    set(value) {
      if (value === current) return;
      current = value;
      paint();
    },
    setDisabled(disabled) {
      row.classList.toggle("is-disabled", disabled);
      button.disabled = disabled;
    },
  };
}

// ------------------------------------------------------------------ colour

export function colorControl(config: {
  label: string;
  value: string;
  onChange(value: string): void;
}): ControlHandle<string> {
  const id = nextId("clr");
  const { row, slot } = field(config.label, id);
  row.classList.add("field--color");

  const wrap = el("div", "colorpick");
  const input = el("input", "colorpick__input");
  input.type = "color";
  input.id = id;
  input.value = config.value;
  const hex = el("span", "colorpick__hex", config.value.toUpperCase());

  input.addEventListener("input", () => {
    hex.textContent = input.value.toUpperCase();
    config.onChange(input.value);
  });

  wrap.append(input, hex);
  slot.append(wrap);

  return {
    el: row,
    set(value) {
      input.value = value;
      hex.textContent = value.toUpperCase();
    },
    setDisabled(disabled) {
      row.classList.toggle("is-disabled", disabled);
      input.disabled = disabled;
    },
  };
}

// ------------------------------------------------------------------ action

export function actionButton(config: {
  label: string;
  onClick(): void;
  hint?: string;
  /** Renders as the section's primary action. */
  primary?: boolean;
}): { el: HTMLElement; setLabel(text: string): void; setDisabled(disabled: boolean): void } {
  const button = el(
    "button",
    `action${config.primary ? " action--primary" : ""}`,
    config.label
  );
  button.type = "button";
  if (config.hint) button.title = config.hint;
  button.addEventListener("click", config.onClick);
  return {
    el: button,
    setLabel(text) {
      button.textContent = text;
    },
    setDisabled(disabled) {
      button.disabled = disabled;
    },
  };
}

/** A row that groups several action buttons side by side. */
export function actionRow(...nodes: HTMLElement[]): HTMLElement {
  const row = el("div", "action-row");
  row.append(...nodes);
  return row;
}

// -------------------------------------------------------------- read-only

/** A non-editable value line, e.g. the active camera. */
export function readout(label: string, value = "—"): ControlHandle<string> {
  const row = el("div", "field field--readout");
  const name = el("span", "field__label", label);
  const slot = el("span", "field__control readout-value", value);
  row.append(name, slot);
  return {
    el: row,
    set(next) {
      if (slot.textContent !== next) slot.textContent = next;
    },
    setDisabled() {
      /* readouts are never interactive */
    },
  };
}

// ------------------------------------------------------------------ section

export type ConsoleSection = {
  readonly el: HTMLElement;
  add(...nodes: HTMLElement[]): void;
  setOpen(open: boolean): void;
  readonly open: boolean;
};

/**
 * A meaning-group of controls with a title-block heading. Collapsible, keyboard
 * operable, and it announces its own state — a plain <details> would not let us
 * style the marker as drafting notation.
 */
export function consoleSection(config: {
  title: string;
  /** Optional one-line description shown under the heading when open. */
  note?: string;
  open?: boolean;
}): ConsoleSection {
  const section = el("section", "section");
  const id = nextId("sec");

  const heading = el("h3", "section__heading");
  const button = el("button", "section__toggle");
  button.type = "button";
  button.setAttribute("aria-controls", id);

  const marker = el("span", "section__marker");
  marker.setAttribute("aria-hidden", "true");
  const title = el("span", "section__title", config.title);
  button.append(marker, title);
  heading.append(button);

  const body = el("div", "section__body");
  body.id = id;
  if (config.note) body.append(el("p", "section__note", config.note));

  let open = config.open ?? false;
  const paint = (): void => {
    button.setAttribute("aria-expanded", open ? "true" : "false");
    section.classList.toggle("is-open", open);
    // `inert` (not just hidden) keeps tab order out of a collapsed section.
    body.inert = !open;
  };
  paint();
  button.addEventListener("click", () => {
    open = !open;
    paint();
  });

  section.append(heading, body);

  return {
    el: section,
    add(...nodes) {
      body.append(...nodes);
    },
    setOpen(next) {
      open = next;
      paint();
    },
    get open() {
      return open;
    },
  };
}
