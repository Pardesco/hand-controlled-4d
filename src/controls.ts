/**
 * InstrumentConsole. Every control writes straight into the live `Settings`
 * object, exactly as the lil-gui panel it replaces did — the contract with
 * `app.ts` (`createControls` -> `Controls`) is unchanged.
 *
 * What changed is the grouping and the control forms. Settings are grouped by
 * MEANING (geometry / gesture response / motion / optics / view / system /
 * advanced) rather than by which subsystem happens to own them, and each value
 * gets the control its data type deserves rather than a seventh identical
 * slider (DESIGN.md §9).
 *
 * Every setting that existed before still exists here. None were dropped.
 */

import type { OutputAspect } from "./layout.ts";
import { POLYTOPE_NAMES } from "./polychora.ts";
import type { ProjectionMode } from "./polytope4d.ts";
import type { CapturePreset, Settings } from "./settings.ts";
import type { InstrumentState, UiMode } from "./ui/state.ts";
import {
  actionButton,
  actionRow,
  colorControl,
  consoleSection,
  instrumentSlider,
  numericControl,
  readout,
  segmentedSelector,
  selectControl,
  toggleControl,
  type ConsoleSection,
  type ControlHandle,
} from "./ui/widgets.ts";

export type DeviceOption = { id: string; label: string };

export type ControlsConfig = {
  settings: Settings;
  devices: DeviceOption[];
  /** False in synthetic mode, where there is no camera to switch to. */
  cameraSwitchingAvailable: boolean;
  onChange: (key?: keyof Settings) => void;
  /** Camera device or capture resolution changed; the source must be restarted. */
  onSourceChange: () => void;
  /** User asked to re-enumerate cameras (e.g. after launching NVIDIA Broadcast). */
  onRescanDevices: () => void;
  onReset: () => void;
  onFullscreen: () => void;
  onToggleRecording: () => void;
  onResetOrientation: () => void;
  onUiModeChange: (mode: UiMode) => void;
  onRestartOnboarding: () => void;
  onShowShortcuts: () => void;
  recordingSupported: boolean;
  cameraLabel: string;
  /** Where the console mounts — the right rail. */
  mount: HTMLElement;
  uiMode: UiMode;
};

export type Controls = {
  refresh(): void;
  /** Rebuilds the device list after a camera is plugged in or started. */
  setDevices(devices: DeviceOption[]): void;
  setVisible(visible: boolean): void;
  toggleVisible(): void;
  readonly visible: boolean;
  setRecording(recording: boolean): void;
  setUiMode(mode: UiMode): void;
  /** Low-frequency system readouts. Caller throttles; this is not a frame path. */
  updateSystem(state: InstrumentState): void;
  /** Onboarding step highlight. */
  highlight(target: string | null): void;
  destroy(): void;
};

const POLYTOPE_LABELS: Record<string, { label: string; hint: string }> = {
  "5-cell": { label: "5", hint: "5-cell — the simplest polychoron" },
  "8-cell": { label: "8", hint: "8-cell — the tesseract" },
  "16-cell": { label: "16", hint: "16-cell" },
  "24-cell": { label: "24", hint: "24-cell — no 3D analogue" },
  "120-cell": { label: "120", hint: "120-cell — dense, forces stereographic" },
  "600-cell": { label: "600", hint: "600-cell — dense, forces stereographic" },
};

export function createControls(config: ControlsConfig): Controls {
  const { settings, onChange } = config;

  const root = document.createElement("div");
  root.className = "console";

  const header = document.createElement("header");
  header.className = "console__header";
  const title = document.createElement("h2");
  title.className = "console__title";
  title.textContent = "Instrument console";
  header.append(title);
  root.append(header);

  const body = document.createElement("div");
  body.className = "console__body";
  root.append(body);

  /** Every control that mirrors a settings value, for `refresh()`. */
  const refreshers: Array<() => void> = [];
  const sections = new Map<string, ConsoleSection>();

  const section = (key: string, cfg: { title: string; note?: string; open?: boolean }) => {
    const made = consoleSection(cfg);
    made.el.dataset.section = key;
    sections.set(key, made);
    body.append(made.el);
    return made;
  };

  const bind = <T,>(handle: ControlHandle<T>, read: () => T) => {
    refreshers.push(() => handle.set(read()));
    return handle;
  };

  // ------------------------------------------------------------- GEOMETRY

  const geometry = section("geometry", {
    title: "Geometry",
    note: "What is being projected, and where it sits in frame.",
    open: true,
  });

  geometry.add(
    bind(
      segmentedSelector({
        label: "Polytope",
        value: settings.polytope,
        options: POLYTOPE_NAMES.map((name) => ({
          value: name,
          label: POLYTOPE_LABELS[name]?.label ?? name,
          hint: POLYTOPE_LABELS[name]?.hint ?? name,
        })),
        onChange: (value) => {
          settings.polytope = value;
          onChange("polytope");
        },
        hint: "Keys 1-6",
      }),
      () => settings.polytope
    ).el
  );

  const projection = bind(
    segmentedSelector<ProjectionMode>({
      label: "Projection",
      value: settings.projection,
      options: [
        { value: "perspective", label: "Perspective", hint: "Best for sparse shapes" },
        { value: "stereographic", label: "Stereographic", hint: "Best for dense shapes" },
      ],
      onChange: (value) => {
        settings.projection = value;
        onChange("projection");
      },
      hint: "Key P",
    }),
    () => settings.projection
  );
  geometry.add(projection.el);

  geometry.add(
    bind(
      instrumentSlider({
        label: "Scale",
        value: settings.objectScale,
        min: 0.3,
        max: 2,
        step: 0.01,
        onChange: (value) => {
          settings.objectScale = value;
          onChange("objectScale");
        },
      }),
      () => settings.objectScale
    ).el
  );

  geometry.add(
    bind(
      instrumentSlider({
        label: "Centre Y",
        value: settings.objectCenterY,
        min: 0.15,
        max: 0.7,
        step: 0.01,
        onChange: (value) => {
          settings.objectCenterY = value;
          onChange("objectCenterY");
        },
        hint: "Vertical placement in the frame",
      }),
      () => settings.objectCenterY
    ).el
  );

  geometry.add(
    actionRow(
      actionButton({
        label: "Reset orientation",
        hint: "Key O",
        onClick: config.onResetOrientation,
      }).el
    )
  );

  // ----------------------------------------------------- GESTURE RESPONSE

  const gesture = section("gesture", {
    title: "Gesture response",
    note: "How the hands are read, and how hard they push.",
    open: true,
  });

  gesture.add(
    bind(
      segmentedSelector<Settings["controlMode"]>({
        label: "Control mode",
        value: settings.controlMode,
        options: [
          { value: "instrument", label: "Instrument", hint: "Thumb-tap select + pinch pedal" },
          { value: "grip", label: "Grip", hint: "Both hands pinch and pull apart" },
        ],
        onChange: (value) => {
          settings.controlMode = value;
          onChange("controlMode");
        },
        hint: "Key M",
      }),
      () => settings.controlMode
    ).el
  );

  gesture.add(
    bind(
      segmentedSelector<Settings["selectorSlot"]>({
        label: "Selector side",
        value: settings.selectorSlot,
        options: [
          { value: "right", label: "Screen right" },
          { value: "left", label: "Screen left" },
        ],
        onChange: (value) => {
          settings.selectorSlot = value;
          onChange("selectorSlot");
        },
        hint: "Which side of the screen picks planes. Roles are assigned by position, never by handedness labels.",
      }),
      () => settings.selectorSlot
    ).el
  );

  gesture.add(
    bind(
      numericControl({
        label: "Pinch engage",
        value: settings.pinchEngageRatio,
        min: 0.15,
        max: 0.8,
        step: 0.01,
        onChange: (value) => {
          settings.pinchEngageRatio = value;
          onChange("pinchEngageRatio");
        },
        hint: "Thumb-to-index distance / palm span below which a pinch registers",
      }),
      () => settings.pinchEngageRatio
    ).el
  );

  gesture.add(
    bind(
      numericControl({
        label: "Pinch release",
        value: settings.pinchReleaseRatio,
        min: 0.2,
        max: 1.1,
        step: 0.01,
        onChange: (value) => {
          settings.pinchReleaseRatio = value;
          onChange("pinchReleaseRatio");
        },
        hint: "Must stay above engage, or the clutch chatters",
      }),
      () => settings.pinchReleaseRatio
    ).el
  );

  gesture.add(
    bind(
      instrumentSlider({
        label: "Hand smoothing",
        value: settings.smoothingAlpha,
        min: 0.05,
        max: 1,
        step: 0.01,
        onChange: (value) => {
          settings.smoothingAlpha = value;
          onChange("smoothingAlpha");
        },
      }),
      () => settings.smoothingAlpha
    ).el
  );

  gesture.add(
    bind(
      instrumentSlider({
        label: "Rate smoothing",
        value: settings.rateSmoothingAlpha,
        min: 0.05,
        max: 1,
        step: 0.01,
        onChange: (value) => {
          settings.rateSmoothingAlpha = value;
          onChange("rateSmoothingAlpha");
        },
      }),
      () => settings.rateSmoothingAlpha
    ).el
  );

  gesture.add(
    bind(
      instrumentSlider({
        label: "Pedal accel",
        value: settings.pedalAccel,
        min: 0.2,
        max: 8,
        step: 0.1,
        accent: "var(--drive)",
        onChange: (value) => {
          settings.pedalAccel = value;
          onChange("pedalAccel");
        },
        hint: "How hard a held pinch pushes, rad/s²",
      }),
      () => settings.pedalAccel
    ).el
  );

  gesture.add(
    bind(
      instrumentSlider({
        label: "One-hand rate",
        value: settings.holdRate,
        min: 0.1,
        max: 3,
        step: 0.05,
        onChange: (value) => {
          settings.holdRate = value;
          onChange("holdRate");
        },
        hint: "Direct drive rate when no pedal hand is in frame",
      }),
      () => settings.holdRate
    ).el
  );

  // --------------------------------------------------------------- MOTION

  const motion = section("motion", {
    title: "Motion",
    note: "What the rotation does once it is moving.",
  });

  motion.add(
    bind(
      instrumentSlider({
        label: "Max speed",
        value: settings.maxRate,
        min: 0.2,
        max: 6,
        step: 0.1,
        accent: "var(--drive)",
        onChange: (value) => {
          settings.maxRate = value;
          onChange("maxRate");
        },
        hint: "Cap on any plane's angular velocity, rad/s",
      }),
      () => settings.maxRate
    ).el
  );

  motion.add(
    bind(
      instrumentSlider({
        label: "Drive friction",
        value: settings.driveFriction,
        min: 0,
        max: 0.99,
        step: 0.01,
        onChange: (value) => {
          settings.driveFriction = value;
          onChange("driveFriction");
        },
        hint: "Velocity lost per second while coasting. 0 spins forever.",
      }),
      () => settings.driveFriction
    ).el
  );

  motion.add(
    bind(
      toggleControl({
        label: "Inertia (throw)",
        value: settings.inertiaEnabled,
        onChange: (value) => {
          settings.inertiaEnabled = value;
          onChange("inertiaEnabled");
        },
        hint: "Grip mode: releasing mid-motion throws it into a free spin",
      }),
      () => settings.inertiaEnabled
    ).el
  );

  motion.add(
    bind(
      instrumentSlider({
        label: "Spin friction",
        value: settings.spinFriction,
        min: 0,
        max: 0.99,
        step: 0.01,
        onChange: (value) => {
          settings.spinFriction = value;
          onChange("spinFriction");
        },
        hint: "Decay of a thrown free spin. 0 spins forever.",
      }),
      () => settings.spinFriction
    ).el
  );

  // --------------------------------------------------------------- OPTICS

  const optics = section("optics", {
    title: "Optics",
    note: "How the polytope is drawn and how the hands occlude it.",
  });

  optics.add(
    bind(
      instrumentSlider({
        label: "Line radius",
        value: settings.tubeRadius,
        min: 0.004,
        max: 0.05,
        step: 0.001,
        onChange: (value) => {
          settings.tubeRadius = value;
          onChange("tubeRadius");
        },
      }),
      () => settings.tubeRadius
    ).el
  );

  optics.add(
    bind(
      instrumentSlider({
        label: "Edge smoothness",
        value: settings.edgeSmoothness,
        min: 0,
        max: 1,
        step: 0.05,
        onChange: (value) => {
          settings.edgeSmoothness = value;
          onChange("edgeSmoothness");
        },
        hint: "How finely curved (stereographic) edges are subdivided. Costs main-thread CPU every frame, alongside hand tracking — raise it only if the render frame time has room.",
      }),
      () => settings.edgeSmoothness
    ).el
  );

  optics.add(
    bind(
      instrumentSlider({
        label: "Glow",
        value: settings.glowStrength,
        min: 0,
        max: 1,
        step: 0.01,
        onChange: (value) => {
          settings.glowStrength = value;
          onChange("glowStrength");
        },
      }),
      () => settings.glowStrength
    ).el
  );

  optics.add(
    bind(
      instrumentSlider({
        label: "Chromatic split",
        value: settings.chromaSplit,
        min: 0,
        max: 0.04,
        step: 0.001,
        onChange: (value) => {
          settings.chromaSplit = value;
          onChange("chromaSplit");
        },
      }),
      () => settings.chromaSplit
    ).el
  );

  optics.add(
    bind(
      instrumentSlider({
        label: "Hue base",
        value: settings.hueBase,
        min: 0,
        max: 1,
        step: 0.01,
        onChange: (value) => {
          settings.hueBase = value;
          onChange("hueBase");
        },
      }),
      () => settings.hueBase
    ).el
  );

  optics.add(
    bind(
      instrumentSlider({
        label: "Hue range (W)",
        value: settings.hueRange,
        min: -1,
        max: 1,
        step: 0.01,
        onChange: (value) => {
          settings.hueRange = value;
          onChange("hueRange");
        },
        hint: "How far the colour travels across the W axis",
      }),
      () => settings.hueRange
    ).el
  );

  optics.add(
    bind(
      colorControl({
        label: "Accent",
        value: settings.accentColor,
        onChange: (value) => {
          settings.accentColor = value;
          onChange("accentColor");
        },
      }),
      () => settings.accentColor
    ).el
  );

  optics.add(
    bind(
      toggleControl({
        label: "Hands occlude",
        value: settings.occlusionEnabled,
        onChange: (value) => {
          settings.occlusionEnabled = value;
          onChange("occlusionEnabled");
        },
        hint: "Depth-only hulls place your hands in front of the polytope",
      }),
      () => settings.occlusionEnabled
    ).el
  );

  optics.add(
    bind(
      instrumentSlider({
        label: "Hull margin",
        value: settings.hullMargin,
        min: 0,
        max: 0.08,
        step: 0.002,
        onChange: (value) => {
          settings.hullMargin = value;
          onChange("hullMargin");
        },
      }),
      () => settings.hullMargin
    ).el
  );

  // ----------------------------------------------------------------- VIEW

  const view = section("view", {
    title: "View",
    note: "Framing, presentation and capture.",
  });

  const uiMode = segmentedSelector<UiMode>({
    label: "Interface",
    value: config.uiMode,
    options: [
      { value: "normal", label: "Normal" },
      { value: "presentation", label: "Present", hint: "Nearly full-screen artwork" },
      { value: "diagnostic", label: "Diag", hint: "Landmarks and engineering telemetry" },
    ],
    onChange: config.onUiModeChange,
    hint: "Key TAB cycles",
  });
  view.add(uiMode.el);

  view.add(
    bind(
      segmentedSelector<OutputAspect>({
        label: "Output frame",
        value: settings.outputAspect,
        options: [
          { value: "9:16", label: "9:16" },
          { value: "4:5", label: "4:5" },
          { value: "1:1", label: "1:1" },
          { value: "16:9", label: "16:9" },
          { value: "fill", label: "Fill" },
        ],
        onChange: (value) => {
          settings.outputAspect = value;
          onChange("outputAspect");
        },
        hint: "The canvas becomes a box of this shape, so captureStream records it directly",
      }),
      () => settings.outputAspect
    ).el
  );

  view.add(
    bind(
      toggleControl({
        label: "Mirror",
        value: settings.mirror,
        onChange: (value) => {
          settings.mirror = value;
          onChange("mirror");
        },
      }),
      () => settings.mirror
    ).el
  );

  const landmarkToggle = bind(
    toggleControl({
      label: "Landmark overlay",
      value: settings.showDebug,
      onChange: (value) => {
        settings.showDebug = value;
        onChange("showDebug");
      },
      hint: "Diagnostic mode (key D) always shows landmarks; this is the preference outside it.",
    }),
    () => settings.showDebug
  );
  view.add(landmarkToggle.el);

  view.add(
    bind(
      instrumentSlider({
        label: "Max pixel ratio",
        value: settings.maxPixelRatio,
        min: 0.5,
        max: 3,
        step: 0.05,
        onChange: (value) => {
          settings.maxPixelRatio = value;
          onChange("maxPixelRatio");
        },
        hint: "Lower this if the render frame rate drops",
      }),
      () => settings.maxPixelRatio
    ).el
  );

  const recordAction = actionButton({
    label: "Record clip",
    hint: "Key V",
    onClick: config.onToggleRecording,
    primary: true,
  });
  if (!config.recordingSupported) recordAction.setDisabled(true);
  view.add(
    actionRow(
      actionButton({ label: "Fullscreen", hint: "Key F", onClick: config.onFullscreen }).el,
      recordAction.el
    )
  );

  // --------------------------------------------------------------- SYSTEM

  const system = section("system", {
    title: "System",
    note: "Capture source and live health.",
  });

  const device = selectControl({
    label: "Camera",
    value: settings.deviceId,
    options: [
      { value: "", label: "Browser default" },
      ...config.devices.map((d) => ({ value: d.id, label: d.label })),
    ],
    onChange: (value) => {
      settings.deviceId = value;
      config.onSourceChange();
    },
  });
  refreshers.push(() => device.set(settings.deviceId));
  if (!config.cameraSwitchingAvailable) device.setDisabled(true);
  system.add(device.el);

  const capture = bind(
    segmentedSelector<CapturePreset>({
      label: "Resolution",
      value: settings.capturePreset,
      options: [
        { value: "720p", label: "720p", hint: "Faster" },
        { value: "1080p", label: "1080p", hint: "Sharper" },
      ],
      onChange: (value) => {
        settings.capturePreset = value;
        config.onSourceChange();
      },
    }),
    () => settings.capturePreset
  );
  if (!config.cameraSwitchingAvailable) capture.setDisabled(true);
  system.add(capture.el);

  const activeCamera = readout("Active source", config.cameraLabel);
  system.add(activeCamera.el);

  // Which build you are actually looking at. A stale asset served from a CDN
  // edge is otherwise indistinguishable from a bug in the current build.
  system.add(readout("Build", __APP_VERSION__).el);

  const stateReadout = readout("State", "—");
  system.add(stateReadout.el);
  const fpsReadout = readout("Render / tracking", "—");
  system.add(fpsReadout.el);
  const handsReadout = readout("Hands", "—");
  system.add(handsReadout.el);

  const rescan = actionButton({
    label: "Rescan cameras",
    hint: "Virtual cameras only appear while their app is running",
    onClick: config.onRescanDevices,
  });
  if (!config.cameraSwitchingAvailable) rescan.setDisabled(true);
  system.add(
    actionRow(
      rescan.el,
      actionButton({ label: "Replay guide", onClick: config.onRestartOnboarding }).el,
      actionButton({ label: "Shortcuts", hint: "Key ?", onClick: config.onShowShortcuts }).el
    )
  );

  // ------------------------------------------------------------- ADVANCED

  const advanced = section("advanced", {
    title: "Advanced",
    note: "Calibration and engineering controls. Rarely changed.",
  });

  advanced.add(
    bind(
      numericControl({
        label: "Reference span",
        value: settings.referenceSpan,
        min: 0.04,
        max: 0.25,
        step: 0.005,
        onChange: (value) => {
          settings.referenceSpan = value;
          onChange("referenceSpan");
        },
        hint: "Palm span at the polytope's depth. Calibrate once per setup — see the README.",
      }),
      () => settings.referenceSpan
    ).el
  );

  advanced.add(
    bind(
      numericControl({
        label: "Detection conf.",
        value: settings.detectionConfidence,
        min: 0.1,
        max: 0.95,
        step: 0.05,
        onChange: (value) => {
          settings.detectionConfidence = value;
          onChange("detectionConfidence");
        },
      }),
      () => settings.detectionConfidence
    ).el
  );

  advanced.add(
    bind(
      numericControl({
        label: "Tracking conf.",
        value: settings.trackingConfidence,
        min: 0.1,
        max: 0.95,
        step: 0.05,
        onChange: (value) => {
          settings.trackingConfidence = value;
          onChange("trackingConfidence");
        },
      }),
      () => settings.trackingConfidence
    ).el
  );

  advanced.add(
    bind(
      numericControl({
        label: "Max hands",
        value: settings.maxHands,
        min: 2,
        max: 6,
        step: 1,
        onChange: (value) => {
          settings.maxHands = value;
          onChange("maxHands");
        },
        hint: "Only two ever drive the rotation; extras let the app choose when a bystander is in frame",
      }),
      () => settings.maxHands
    ).el
  );

  advanced.add(
    bind(
      toggleControl({
        label: "Swap L/R labels",
        value: settings.swapHandedness,
        onChange: (value) => {
          settings.swapHandedness = value;
          onChange("swapHandedness");
        },
        hint: "MediaPipe handedness is inverted on some webcams",
      }),
      () => settings.swapHandedness
    ).el
  );

  advanced.add(
    bind(
      toggleControl({
        label: "View orbit (XZ/YZ)",
        value: settings.orbitEnabled,
        onChange: (value) => {
          settings.orbitEnabled = value;
          onChange("orbitEnabled");
        },
      }),
      () => settings.orbitEnabled
    ).el
  );

  advanced.add(
    bind(
      instrumentSlider({
        label: "Orbit gain",
        value: settings.gainOrbit,
        min: 0,
        max: 8,
        step: 0.1,
        onChange: (value) => {
          settings.gainOrbit = value;
          onChange("gainOrbit");
        },
      }),
      () => settings.gainOrbit
    ).el
  );

  const gainsNote = document.createElement("p");
  gainsNote.className = "section__subnote";
  gainsNote.textContent = "Grip-mode axis gains — how each pull maps onto a plane.";
  advanced.add(gainsNote);

  const gains: Array<[keyof Settings, string, number, number, number]> = [
    ["gainZW", "Pull → ZW", 0, 12, 0.1],
    ["gainXY", "Turn → XY", 0, 4, 0.05],
    ["gainYW", "Tip → YW", 0, 8, 0.1],
    ["gainXW", "Twist → XW", 0, 4, 0.05],
  ];
  for (const [key, label, min, max, step] of gains) {
    advanced.add(
      bind(
        instrumentSlider({
          label,
          value: settings[key] as number,
          min,
          max,
          step,
          onChange: (value) => {
            (settings[key] as number) = value;
            onChange(key);
          },
        }),
        () => settings[key] as number
      ).el
    );
  }

  advanced.add(
    actionRow(actionButton({ label: "Reset all settings", hint: "Key R", onClick: config.onReset }).el)
  );

  config.mount.append(root);

  let visible = true;

  return {
    refresh() {
      for (const refreshValue of refreshers) refreshValue();
    },
    setDevices(devices) {
      const options = [
        { value: "", label: "Browser default" },
        ...devices.map((d) => ({ value: d.id, label: d.label })),
      ];
      // A remembered device that is no longer attached must still be selectable.
      if (settings.deviceId && !devices.some((d) => d.id === settings.deviceId)) {
        options.push({ value: settings.deviceId, label: "Remembered device (unavailable)" });
      }
      device.setOptions(options);
      device.set(settings.deviceId);
    },
    setVisible(next) {
      visible = next;
      config.mount.dataset.open = String(next);
      config.mount.inert = !next;
    },
    toggleVisible() {
      this.setVisible(!visible);
    },
    get visible() {
      return visible;
    },
    setRecording(recording) {
      recordAction.setLabel(recording ? "Stop recording" : "Record clip");
    },
    setUiMode(mode) {
      uiMode.set(mode);
      // Diagnostic mode owns the landmark overlay, so the toggle shows ON and
      // goes inert rather than sitting there appearing to do nothing.
      const diagnostic = mode === "diagnostic";
      landmarkToggle.set(diagnostic ? true : settings.showDebug);
      landmarkToggle.setDisabled(diagnostic);
      // Diagnostic work happens in ADVANCED; open it so the mode is useful
      // the moment it is entered.
      if (diagnostic) advanced.setOpen(true);
    },
    updateSystem(state) {
      activeCamera.set(state.camera);
      stateReadout.set(state.frozen ? `${state.condition} (frozen)` : state.condition);
      fpsReadout.set(
        `${state.renderFps.toFixed(0)} / ${state.trackingFps > 0 ? state.trackingFps.toFixed(0) : "—"} fps`
      );
      handsReadout.set(`${state.handsDetected}/2 of ${state.handsInFrame} in frame`);
    },
    highlight(target) {
      for (const [key, made] of sections) {
        made.el.dataset.highlight = String(target === key);
      }
      if (target && sections.has(target)) sections.get(target)?.setOpen(true);
    },
    destroy() {
      root.remove();
    },
  };
}
