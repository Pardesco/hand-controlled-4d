/**
 * Wires camera -> tracking -> assignment -> smoothing -> gesture -> 4D
 * rotation -> renderer, and owns the single requestAnimationFrame loop.
 *
 * Rendering runs every frame at display refresh rate. Tracking runs only when
 * the webcam has produced a new frame, and the renderer always uses the most
 * recent landmark result. The two rates are therefore independent, which is
 * why a 30 FPS camera still gives a 60 FPS polytope.
 */

import {
  AppError,
  listVideoDevices,
  startCamera,
  startSyntheticSource,
  type CameraRequest,
  type VideoSource,
} from "./camera.ts";
import { computeCropTransform, videoToDisplay, type CropTransform } from "./coords.ts";
import { createControls, type Controls } from "./controls.ts";
import { DebugOverlay, type OverlayHand } from "./debugOverlay.ts";
import { detectDevice, deviceDefaults, tryLockLandscape } from "./device.ts";
import { GestureMapper, type GestureFrame, type GestureHandInput } from "./gestureMap.ts";
import { FINGER_MAP, PlaneDriveMapper, THUMB_TIP, type PlaneDriveFrame } from "./planeDrive.ts";
import { assignHands, NO_HANDS } from "./handAssignment.ts";
import { buildHandMask, DEFAULT_DEPTH_OPTIONS, type HandMask } from "./handMask.ts";
import { applyHandednessSwap, HandTracker, LANDMARK, type TrackerOptions } from "./handTracker.ts";
import { computeFrameSize, OUTPUT_ASPECTS } from "./layout.ts";
import { buildPolytope, POLYTOPE_NAMES, STEREOGRAPHIC_ONLY, type PolytopeName } from "./polychora.ts";
import {
  composePlaneRotations,
  identity,
  orthonormalize,
  PLANES,
  type PlaneAngles,
  type RotationPlane,
} from "./polytope4d.ts";
import { CanvasRecorder } from "./recorder.ts";
import {
  SceneRenderer,
  type FeedbackState,
  type MarkerFeedback,
  type RingFeedback,
} from "./sceneRenderer.ts";
import {
  CAPTURE_PRESETS,
  clearSettings,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type Settings,
} from "./settings.ts";
import { dampTowards, Vec2Smoother } from "./smoothing.ts";
import type { AssignedHands, Point2D, TrackedHand } from "./types.ts";
import { createInstrumentHud, type InstrumentHud } from "./ui/hud.ts";
import { KeyboardDrive } from "./ui/keyboardDrive.ts";
import { calibrationFlow, type CalibrationFlow } from "./ui/onboarding.ts";
import {
  createInstrumentState,
  FINGER_NAMES,
  type FingerName,
  type InstrumentState,
  type UiMode,
} from "./ui/state.ts";

/** Frames between Gram-Schmidt re-orthonormalisations of the orientation. */
const RENORMALIZE_EVERY = 30;
/** Half-life of the engage-frame fade, seconds. */
const ENGAGE_HALF_LIFE = 0.08;

const HAND_COLORS = { left: "#ff8a3d", right: "#3dd6ff" } as const;

/**
 * Plane -> the finger whose thumb-tap selects it, derived from the gesture
 * layer's own map so the two can never drift apart. Planes with no finger
 * (XZ, YZ) are reachable through the view orbit only.
 */
const PLANE_UI: Record<RotationPlane, { finger: FingerName | null }> = {
  XY: { finger: null },
  XZ: { finger: null },
  XW: { finger: null },
  YZ: { finger: null },
  YW: { finger: null },
  ZW: { finger: null },
};
for (const finger of FINGER_MAP) {
  PLANE_UI[finger.plane] = { finger: finger.name };
}

export type AppElements = {
  /** InstrumentShell root; carries `data-mode` and `data-chrome`. */
  shell: HTMLElement;
  /** The centre column. The composition is sized to THIS, never to the window. */
  stage: HTMLElement;
  /** Letterboxed box holding the canvases and the two state bands. */
  aperture: HTMLElement;
  sceneCanvas: HTMLCanvasElement;
  overlayCanvas: HTMLCanvasElement;
  bandTop: HTMLElement;
  bandBottom: HTMLElement;
  railLeft: HTMLElement;
  railLeftScroll: HTMLElement;
  railLeftTab: HTMLButtonElement;
  railRight: HTMLElement;
  railRightTab: HTMLButtonElement;
  statusEl: HTMLElement;
  bootEl: HTMLElement;
  bootStatusEl: HTMLElement;
  recIndicator: HTMLElement;
  recTime: HTMLElement;
  onboardingMount: HTMLElement;
  shortcutsEl: HTMLElement;
  shortcutsClose: HTMLButtonElement;
};

/** Smoothed display-space key points for one hand slot. */
type SlotSmoothers = {
  thumb: Vec2Smoother;
  index: Vec2Smoother;
  wrist: Vec2Smoother;
  middle: Vec2Smoother;
};

function makeSlotSmoothers(alpha: number): SlotSmoothers {
  return {
    thumb: new Vec2Smoother(alpha),
    index: new Vec2Smoother(alpha),
    wrist: new Vec2Smoother(alpha),
    middle: new Vec2Smoother(alpha),
  };
}

function resetSlot(slot: SlotSmoothers): void {
  slot.thumb.reset();
  slot.index.reset();
  slot.wrist.reset();
  slot.middle.reset();
}

function setSlotAlpha(slot: SlotSmoothers, alpha: number): void {
  slot.thumb.setAlpha(alpha);
  slot.index.setAlpha(alpha);
  slot.wrist.setAlpha(alpha);
  slot.middle.setAlpha(alpha);
}

export class App {
  /** Phone / tablet vs desk machine; decides the factory settings below. */
  private readonly device = detectDevice();
  private readonly defaults: Settings = { ...DEFAULT_SETTINGS, ...deviceDefaults(this.device) };
  private settings: Settings = loadSettings(this.defaults);

  private source: VideoSource | null = null;
  private tracker: HandTracker | null = null;
  private renderer: SceneRenderer;
  private overlay: DebugOverlay;
  private controls: Controls | null = null;
  private recorder: CanvasRecorder;

  private crop: CropTransform = computeCropTransform(1, 1, 1, 1, this.settings.mirror);

  private readonly slotLeft = makeSlotSmoothers(this.settings.smoothingAlpha);
  private readonly slotRight = makeSlotSmoothers(this.settings.smoothingAlpha);
  private readonly gesture = new GestureMapper(this.gestureOptions());
  private readonly planeDrive = new PlaneDriveMapper(this.driveOptions());
  /** Whichever control layer ran this frame, for the overlay bars. */
  private readonly totalIncrements: PlaneAngles = { XY: 0, XZ: 0, XW: 0, YZ: 0, YW: 0, ZW: 0 };
  /** The hand playing each instrument role this frame (assigned by position). */
  private currentSelector: TrackedHand | null = null;
  private currentPedal: TrackedHand | null = null;
  /** Inert stand-in gesture frame for instrument mode. */
  private readonly idleGesture: GestureFrame = {
    engaged: false,
    spinning: false,
    leftPinched: false,
    rightPinched: false,
    increments: { XY: 0, XZ: 0, XW: 0, YZ: 0, YW: 0, ZW: 0 },
  };

  /** Accumulated 4D orientation. */
  private rotation = identity();
  private framesSinceRenormalize = 0;
  private frozen = false;
  private lastGestureFrame: GestureFrame | null = null;

  private assigned: AssignedHands = NO_HANDS;
  private handsInFrame = 0;
  private lastBothHandsAt = 0;

  private rafId = 0;
  private running = false;
  private lastFrameTime = 0;
  private renderFps = 0;
  private trackingFps = 0;
  private lastTrackTime = 0;
  private statusTimer: number | null = null;
  private disposed = false;

  private readonly overlayHands: OverlayHand[] = [];
  private overlayDrawn = false;
  private saveTimer: number | null = null;
  private switchingCamera = false;
  private handHintShown = false;
  /** A sticky error (stream lost, model failed) must not be overwritten by hints. */
  private persistentError = false;
  /** Remembers an explicit `G` hide so leaving fullscreen does not undo it. */
  private guiHiddenByUser = false;

  private readonly feedback: FeedbackState = { left: null, right: null, engage: 0, markers: [] };
  /** Preallocated marker pool: 4 plane fingers + thumb reverse indicator. */
  private readonly markerPool: MarkerFeedback[] = Array.from({ length: 5 }, () => ({
    center: { x: 0, y: 0 },
    radius: 0,
    intensity: 0,
    color: "#ffffff",
  }));
  private readonly ringLeft: RingFeedback = { center: { x: 0, y: 0 }, radius: 0, intensity: 0 };
  private readonly ringRight: RingFeedback = { center: { x: 0, y: 0 }, radius: 0, intensity: 0 };
  private readonly masks: (HandMask | null)[] = [null, null];

  // ------------------------------------------------------------------- UI
  /** Reused every frame; the HUD change-detects rather than re-rendering. */
  private readonly uiState: InstrumentState = createInstrumentState();
  private readonly hud: InstrumentHud;
  private readonly calibration: CalibrationFlow;
  /** The no-hands fallback: latched planes driven by W / S. */
  private readonly keyboard = new KeyboardDrive({
    pedalAccel: this.settings.pedalAccel,
    maxRate: this.settings.maxRate,
    friction: this.settings.driveFriction,
  });
  private uiMode: UiMode = this.settings.uiMode;
  private railLeftOpen = true;
  private stageObserver: ResizeObserver | null = null;
  /** Console readouts are not a frame path; they refresh a few times a second. */
  private lastSystemPush = 0;

  constructor(private el: AppElements) {
    this.renderer = new SceneRenderer(el.sceneCanvas);
    this.overlay = new DebugOverlay(el.overlayCanvas);
    this.recorder = new CanvasRecorder(el.sceneCanvas);
    // Seed the uniform so `updateCrop`'s change detection has a truthful baseline.
    this.renderer.setCrop(this.crop);
    this.applyPolytope();

    this.hud = createInstrumentHud({
      rail: el.railLeftScroll,
      bandTop: el.bandTop,
      bandBottom: el.bandBottom,
      shell: el.shell,
      onLatch: (plane, latched) => {
        this.keyboard.setLatched(plane, latched);
        this.hud.setLatched(this.keyboard.latched);
      },
    });

    this.calibration = calibrationFlow({
      onFinish: (completed) => {
        this.settings.onboardingDone = true;
        this.queueSave();
        this.controls?.highlight(null);
        if (completed) this.setStatus("Guide complete. Replay it from System.", 3000);
      },
      onHighlight: (target) => {
        for (const panel of el.railLeftScroll.querySelectorAll<HTMLElement>(".panel")) {
          panel.dataset.highlight = "false";
        }
        if (target) {
          const panel = el.railLeftScroll.querySelector<HTMLElement>(`.panel--${target}`);
          if (panel) panel.dataset.highlight = "true";
        }
        this.controls?.highlight(target);
      },
    });
    el.onboardingMount.append(this.calibration.el);

    el.railLeftTab.addEventListener("click", () => this.setRailLeftOpen(!this.railLeftOpen));
    el.railRightTab.addEventListener("click", () => this.toggleConsole());
    el.shortcutsClose.addEventListener("click", () => this.setShortcuts(false));

    // Any input keeps presentation-mode chrome awake.
    window.addEventListener("pointerdown", this.handleActivity, { passive: true });
    window.addEventListener("resize", this.handleResize);
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
    window.addEventListener("blur", this.handleBlur);
    window.addEventListener("beforeunload", this.handleUnload);
    document.addEventListener("fullscreenchange", this.handleFullscreenChange);

    // A rail opening or closing changes the stage without a window resize.
    if (typeof ResizeObserver !== "undefined") {
      this.stageObserver = new ResizeObserver(() => this.handleResize());
      this.stageObserver.observe(el.stage);
    }

    this.applyUiMode(this.uiMode, false);
    this.handleResize();
  }

  // -------------------------------------------------------------- lifecycle

  async start(synthetic: boolean): Promise<void> {
    this.el.bootStatusEl.textContent = synthetic
      ? "Starting synthetic source..."
      : "Waiting for webcam permission...";
    try {
      this.source = synthetic
        ? await startSyntheticSource()
        : await startCamera(this.captureRequest());
    } catch (err) {
      // Surface the message, then rethrow so main.ts can tear this instance down
      // and re-enable the start buttons.
      this.el.bootStatusEl.textContent = "";
      this.reportError(err);
      throw err;
    }

    this.watchStream(this.source);

    // The model is loaded in synthetic mode too: it is the only way to verify
    // that the local WASM runtime and .task file resolve correctly on a machine
    // with no webcam. Synthetic frames contain no hands, so scripted hands
    // drive the rotation either way.
    //
    // This happens BEFORE the canvas is revealed on purpose. Instantiating the
    // MediaPipe graph blocks the main thread for seconds on a cold start,
    // during which no video frame can be uploaded -- showing the canvas first
    // would mean showing a black rectangle until the block cleared.
    this.el.bootStatusEl.textContent =
      "Loading hand tracking model (first run reads ~19 MB of local assets)...";
    try {
      this.tracker = await HandTracker.create(this.trackerOptions());
      // Key hints are noise on a device with no keyboard; the console carries
      // the same switches.
      const keys = this.device.handheld ? "" : " M switches modes.";
      this.setStatus(
        synthetic
          ? this.device.handheld
            ? "Synthetic mode: scripted hands drive the rotation."
            : "Synthetic mode: scripted hands drive the rotation. Press D for diagnostic mode, ? for keys."
          : this.settings.controlMode === "instrument"
            ? `Tap thumb to a finger (right hand) to pick a plane; pinch-hold the left hand to accelerate; fist to stop.${keys}`
            : `Pinch thumb to index on BOTH hands to grip. Pull apart to turn it inside out.${keys}`,
        7000
      );
      this.lastBothHandsAt = performance.now();
    } catch (err) {
      // Tracking is dead. Unlike the portal app there is no fallback effect --
      // the whole piece is the interaction -- but surface the error and keep
      // the compositor alive so the user still sees themself.
      this.reportError(err);
    }

    // Main thread is free again, so the video texture will get its first upload
    // on the very next frame. Now it is safe to show the canvas.
    this.renderer.setVideo(this.source.video);
    this.handleResize();
    this.el.bootStatusEl.textContent = "";
    this.el.bootEl.classList.add("hidden");

    this.running = true;
    this.lastFrameTime = performance.now();
    this.rafId = requestAnimationFrame(this.loop);

    // Device labels are only populated once permission has been granted, which
    // is why the list is read here rather than before the camera starts.
    const devices = synthetic ? [] : await listVideoDevices();

    this.controls = createControls({
      settings: this.settings,
      devices: devices.map((d, i) => ({
        id: d.deviceId,
        label: d.label || `Camera ${i + 1}`,
      })),
      cameraSwitchingAvailable: !synthetic,
      onChange: (key) => this.applySettings(key),
      onSourceChange: () => void this.restartCamera(),
      onRescanDevices: () => void this.rescanDevices(true),
      onReset: () => this.resetSettings(),
      onFullscreen: () => this.toggleFullscreen(),
      onToggleRecording: () => void this.toggleRecording(),
      onResetOrientation: () => this.resetOrientation(),
      onUiModeChange: (mode) => this.applyUiMode(mode, true),
      onRestartOnboarding: () => this.calibration.start(),
      onShowShortcuts: () => this.setShortcuts(true),
      recordingSupported: CanvasRecorder.supported,
      cameraLabel: this.source.label,
      mount: this.el.railRight,
      uiMode: this.uiMode,
    });
    this.applySettings();
    this.applyUiMode(this.uiMode, false);

    // First run only: the guide teaches the two hand roles, then stays
    // available from the console.
    if (!this.settings.onboardingDone && !synthetic) this.calibration.start();

    // Virtual cameras (NVIDIA Broadcast, OBS) only register a device while
    // their app is running, so a list captured once at startup goes stale.
    if (!synthetic && navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener("devicechange", this.handleDeviceChange);
    }
  }

  private handleDeviceChange = (): void => void this.rescanDevices(false);

  private async rescanDevices(announce: boolean): Promise<void> {
    if (this.disposed || !this.source || this.source.synthetic) return;
    const devices = await listVideoDevices();
    this.controls?.setDevices(
      devices.map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }))
    );
    if (announce) {
      this.setStatus(
        devices.length > 1
          ? `Found ${devices.length} cameras.`
          : "Only one camera found. Virtual cameras (NVIDIA Broadcast, OBS) must be running before they appear here.",
        4000
      );
    }
  }

  private trackerOptions(): TrackerOptions {
    return {
      minHandDetectionConfidence: this.settings.detectionConfidence,
      minHandPresenceConfidence: this.settings.detectionConfidence,
      minTrackingConfidence: this.settings.trackingConfidence,
      numHands: Math.round(this.settings.maxHands),
    };
  }

  private captureRequest(): CameraRequest {
    const preset = CAPTURE_PRESETS[this.settings.capturePreset] ?? CAPTURE_PRESETS["720p"];
    return {
      deviceId: this.settings.deviceId || undefined,
      width: preset.width,
      height: preset.height,
    };
  }

  /**
   * Swaps to a different camera or capture resolution without rebuilding the
   * renderer. If the requested device is gone, falls back to the browser's
   * default rather than leaving the app with no video at all.
   */
  private async restartCamera(): Promise<void> {
    if (!this.source || this.source.synthetic || this.switchingCamera) return;
    this.switchingCamera = true;
    const previous = this.source;
    this.setStatus("Switching camera...", 0);
    try {
      let next: VideoSource;
      try {
        next = await startCamera(this.captureRequest());
      } catch (err) {
        if (!this.settings.deviceId) throw err;
        // The remembered device is unavailable; retry with whatever is there.
        this.settings.deviceId = "";
        this.controls?.refresh();
        next = await startCamera(this.captureRequest());
      }
      previous.stop();
      this.source = next;
      this.renderer.setVideo(next.video);
      this.watchStream(next);
      this.tracker?.invalidate();
      this.resetTrackingState();
      this.handleResize();
      this.setStatus(`Now using ${next.label}.`, 2500);
      this.queueSave();
    } catch (err) {
      this.reportError(err);
    } finally {
      this.switchingCamera = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    if (this.statusTimer !== null) clearTimeout(this.statusTimer);
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      saveSettings(this.settings); // flush a pending change before the page goes
    }
    navigator.mediaDevices?.removeEventListener("devicechange", this.handleDeviceChange);
    window.removeEventListener("resize", this.handleResize);
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    window.removeEventListener("blur", this.handleBlur);
    window.removeEventListener("pointerdown", this.handleActivity);
    window.removeEventListener("beforeunload", this.handleUnload);
    document.removeEventListener("fullscreenchange", this.handleFullscreenChange);
    this.stageObserver?.disconnect();
    this.hud.dispose();
    this.recorder.dispose();
    this.controls?.destroy();
    this.tracker?.close();
    this.source?.stop(); // camera light off
    this.renderer.dispose();
  }

  private handleUnload = (): void => this.dispose();

  /** A webcam can vanish mid-session (unplugged, or grabbed by another app). */
  private watchStream(source: VideoSource): void {
    const stream = source.video.srcObject;
    if (!(stream instanceof MediaStream)) return;
    for (const track of stream.getVideoTracks()) {
      track.addEventListener("ended", () => {
        this.setStatus("The webcam stream ended. Reconnect the camera and reload the page.", 0, true);
      });
      track.addEventListener("mute", () => {
        this.setStatus(
          "The webcam stopped sending frames. Another app may have taken the camera.",
          0,
          true
        );
      });
      track.addEventListener("unmute", () => {
        this.setStatus("Webcam stream resumed.", 2000);
      });
    }
  }

  private resetTrackingState(): void {
    resetSlot(this.slotLeft);
    resetSlot(this.slotRight);
    this.gesture.reset();
    this.planeDrive.reset();
    this.assigned = NO_HANDS;
  }

  // ------------------------------------------------------------------ loop

  private loop = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    const dt = Math.min(0.25, Math.max(1e-4, (now - this.lastFrameTime) / 1000));
    this.lastFrameTime = now;
    this.renderFps += (1 / dt - this.renderFps) * 0.08;

    const source = this.source;
    if (!source) return;

    this.updateCrop();
    this.updateTracking(source, now);
    // The two control schemes are exclusive modes: a selector tap IS a pinch
    // geometrically, so running both had grip-and-pull engaging (and braking
    // everything) whenever both hands touched fingers. updateGesture still
    // runs in instrument mode -- it feeds the slot smoothers the rings and
    // pinch detection depend on -- but its rotation output is discarded.
    const instrument = this.settings.controlMode === "instrument";
    const realGesture = this.updateGesture(dt);
    const gestureFrame = instrument ? this.idleGesture : realGesture;
    const driveFrame = instrument ? this.updatePlaneDrive(dt) : null;
    const keyboardFrame = this.keyboard.update(dt);
    this.updateRotation(gestureFrame, driveFrame, keyboardFrame);
    this.updateOcclusion();
    this.updateFeedback(gestureFrame, driveFrame, dt);

    this.renderer.updateOrientation(this.rotation);
    this.renderer.render();

    this.updateOverlay(gestureFrame);
    this.updateInstrument(gestureFrame, driveFrame, now);
    this.updateHandHint(now);
    this.updateRecordingIndicator();
  };

  private updateCrop(): void {
    const source = this.source;
    if (!source || source.video.videoWidth === 0) return;
    const { width, height } = this.renderer.drawingBufferSize;
    const next = computeCropTransform(
      source.video.videoWidth,
      source.video.videoHeight,
      width,
      height,
      this.settings.mirror
    );
    const previous = this.crop;
    if (
      next.fracX === previous.fracX &&
      next.fracY === previous.fracY &&
      next.mirrored === previous.mirrored
    ) {
      return; // nothing moved; skip the uniform write and keep the same object
    }
    this.crop = next;
    // The display transform changed (window resized, camera swapped, mirror
    // toggled): smoothed history and gesture deltas from the old mapping would
    // fling the rotation. Drop both.
    this.resetTrackingState();
    this.renderer.setCrop(next);
  }

  private updateTracking(source: VideoSource, now: number): void {
    if (source.synthetic) {
      this.assigned = syntheticHands(now);
      this.handsInFrame = 2;
      this.lastBothHandsAt = now;
      return;
    }
    const tracker = this.tracker;
    if (!tracker) return;

    const detected = tracker.detect(source.video, now);
    if (detected === null) return; // duplicate frame: keep the previous assignment

    const dtTrack = this.lastTrackTime > 0 ? (now - this.lastTrackTime) / 1000 : 0;
    this.lastTrackTime = now;
    if (dtTrack > 0) this.trackingFps += (1 / dtTrack - this.trackingFps) * 0.15;

    this.handsInFrame = detected.length;
    this.assigned = assignHands(
      applyHandednessSwap(detected, this.settings.swapHandedness),
      this.assigned
    );
    if (this.assigned.left && this.assigned.right) this.lastBothHandsAt = now;
  }

  /**
   * Turns a tracked hand into the gesture layer's aspect-corrected input.
   * Smoothing happens here, in display space, per spec §7: smooth positions
   * first, derive rates from smoothed values (gestureMap then damps the rates
   * again).
   */
  private buildGestureInput(
    hand: TrackedHand | null,
    slot: SlotSmoothers,
    dt: number,
    aspect: number,
    out: GestureHandInput
  ): GestureHandInput | null {
    if (!hand) {
      resetSlot(slot);
      return null;
    }
    const middleMcp = hand.landmarks[LANDMARK.middleMcp] ?? hand.palmCenter;
    const thumb = slot.thumb.update(videoToDisplay(hand.thumbTip, this.crop), dt);
    const index = slot.index.update(videoToDisplay(hand.indexTip, this.crop), dt);
    const wrist = slot.wrist.update(videoToDisplay(hand.wrist, this.crop), dt);
    const middle = slot.middle.update(videoToDisplay(middleMcp, this.crop), dt);

    // Aspect correction: multiply x by width/height so distances and angles
    // are isotropic in screen terms.
    const tx = thumb.x * aspect;
    const ix = index.x * aspect;
    const wx = wrist.x * aspect;
    const mx = middle.x * aspect;

    out.pinchPoint.x = (tx + ix) * 0.5;
    out.pinchPoint.y = (thumb.y + index.y) * 0.5;
    out.pinchDistance = Math.hypot(ix - tx, index.y - thumb.y);
    out.span = Math.hypot(mx - wx, middle.y - wrist.y);
    out.twistAngle = Math.atan2(middle.y - wrist.y, mx - wx);
    return out;
  }

  private readonly gestureInputLeft: GestureHandInput = {
    pinchPoint: { x: 0, y: 0 },
    pinchDistance: 0,
    span: 0,
    twistAngle: 0,
  };
  private readonly gestureInputRight: GestureHandInput = {
    pinchPoint: { x: 0, y: 0 },
    pinchDistance: 0,
    span: 0,
    twistAngle: 0,
  };

  private updateGesture(dt: number): GestureFrame {
    const { width, height } = this.renderer.drawingBufferSize;
    const aspect = height > 0 ? width / height : 1;
    const left = this.buildGestureInput(
      this.assigned.left,
      this.slotLeft,
      dt,
      aspect,
      this.gestureInputLeft
    );
    const right = this.buildGestureInput(
      this.assigned.right,
      this.slotRight,
      dt,
      aspect,
      this.gestureInputRight
    );
    const frame = this.gesture.update(left, right, dt);
    this.lastGestureFrame = frame;
    return frame;
  }

  /**
   * The instrument: the selector hand's thumb-taps pick planes, the other
   * hand's pinch is the one speed control. Roles are assigned by SCREEN
   * POSITION each frame -- MediaPipe handedness labels are inverted on many
   * webcams and must never decide which hand does what. With one hand in
   * frame, that hand is the selector (one-hand fallback drive).
   */
  private updatePlaneDrive(dt: number): PlaneDriveFrame {
    const a = this.assigned.left;
    const b = this.assigned.right;
    let selector: TrackedHand | null;
    let pedal: TrackedHand | null;
    if (a && b) {
      const ax = videoToDisplay(a.palmCenter, this.crop).x;
      const bx = videoToDisplay(b.palmCenter, this.crop).x;
      const screenRight = ax >= bx ? a : b;
      const screenLeft = ax >= bx ? b : a;
      if (this.settings.selectorSlot === "right") {
        selector = screenRight;
        pedal = screenLeft;
      } else {
        selector = screenLeft;
        pedal = screenRight;
      }
    } else {
      selector = a ?? b;
      pedal = null;
    }
    this.currentSelector = selector;
    this.currentPedal = pedal;
    return this.planeDrive.update(selector, pedal, dt);
  }

  private updateRotation(
    frame: GestureFrame,
    driveFrame: PlaneDriveFrame | null,
    keyboardFrame: Readonly<PlaneAngles>
  ): void {
    let any = false;
    for (const plane of PLANES) {
      const total =
        frame.increments[plane] + (driveFrame?.increments[plane] ?? 0) + keyboardFrame[plane];
      this.totalIncrements[plane] = total;
      if (total !== 0) any = true;
    }
    if (this.frozen || !any) return;
    composePlaneRotations(this.rotation, this.totalIncrements);
    this.framesSinceRenormalize += 1;
    if (this.framesSinceRenormalize >= RENORMALIZE_EVERY) {
      orthonormalize(this.rotation);
      this.framesSinceRenormalize = 0;
    }
  }

  /** Scratch for display-converted landmarks; reused, max 21 points. */
  private readonly hullScratch: Point2D[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0 }));

  private updateOcclusion(): void {
    const slots = [this.assigned.left, this.assigned.right];
    for (let i = 0; i < 2; i += 1) {
      const hand = slots[i];
      if (!this.settings.occlusionEnabled || !hand || hand.landmarks.length < 3) {
        this.masks[i] = null;
        continue;
      }
      const n = Math.min(hand.landmarks.length, this.hullScratch.length);
      for (let k = 0; k < n; k += 1) {
        const display = videoToDisplay(hand.landmarks[k]!, this.crop);
        this.hullScratch[k]!.x = display.x;
        this.hullScratch[k]!.y = display.y;
      }
      this.masks[i] = buildHandMask(
        this.hullScratch.slice(0, n),
        hand.span,
        this.settings.hullMargin,
        {
          ...DEFAULT_DEPTH_OPTIONS,
          referenceSpan: this.settings.referenceSpan,
        }
      );
    }
    this.renderer.setHandMasks(this.masks);
  }

  /**
   * The selector hand's fingertip legend: a dot per finger in its plane's
   * colour, always faintly visible (so the controls are discoverable on
   * camera), bright with the plane tag while tapped, plus a neutral dot on
   * the thumb -- the contact pad. Recorded: diegetic UI, not debug.
   */
  private updateMarkers(driveFrame: PlaneDriveFrame | null): void {
    this.feedback.markers.length = 0;
    if (!driveFrame) return;
    const hand = this.currentSelector;
    if (!hand || hand.landmarks.length < 21) return;

    for (let i = 0; i < FINGER_MAP.length; i += 1) {
      const finger = FINGER_MAP[i]!;
      const tip = hand.landmarks[finger.tip];
      if (!tip) continue;
      const marker = this.markerPool[i]!;
      const display = videoToDisplay(tip, this.crop);
      marker.center.x = display.x;
      marker.center.y = display.y;
      const touched = driveFrame.touches[finger.name];
      marker.radius = touched ? 0.013 : 0.007;
      marker.intensity = touched ? 0.95 : 0.28;
      marker.color = finger.color;
      // The plane tag rides the fingertip while tapped, so which plane is
      // active is readable at the hand itself, not just the debug bars.
      marker.label = touched ? finger.plane : undefined;
      this.feedback.markers.push(marker);
    }

    const thumbTip = hand.landmarks[THUMB_TIP];
    if (thumbTip) {
      const marker = this.markerPool[FINGER_MAP.length]!;
      const display = videoToDisplay(thumbTip, this.crop);
      marker.center.x = display.x;
      marker.center.y = display.y;
      marker.radius = 0.006;
      marker.intensity = 0.2;
      marker.color = "#ffffff";
      marker.label = undefined;
      this.feedback.markers.push(marker);
    }
  }

  private updateFeedback(frame: GestureFrame, driveFrame: PlaneDriveFrame | null, dt: number): void {
    const instrument = driveFrame !== null;
    const rings = [
      { hand: this.assigned.left, slot: this.slotLeft, pinched: frame.leftPinched, out: this.ringLeft },
      { hand: this.assigned.right, slot: this.slotRight, pinched: frame.rightPinched, out: this.ringRight },
    ];
    this.feedback.left = null;
    this.feedback.right = null;
    for (let i = 0; i < 2; i += 1) {
      const { hand, slot, out } = rings[i]!;
      let { pinched } = rings[i]!;
      // Instrument mode: the ring belongs to the PEDAL hand only (the
      // selector wears the fingertip legend instead), and it brightens
      // while the pedal is down.
      if (instrument) {
        if (hand === null || hand !== this.currentPedal) continue;
        pinched = driveFrame.pedal || driveFrame.braking;
      }
      const thumb = slot.thumb.current;
      const index = slot.index.current;
      if (!hand || !thumb || !index) continue;
      out.center.x = (thumb.x + index.x) * 0.5;
      out.center.y = (thumb.y + index.y) * 0.5;
      // Ring closes as the pinch closes; aspect handled by the renderer.
      const gap = Math.hypot(index.x - thumb.x, index.y - thumb.y);
      out.radius = Math.min(0.09, Math.max(0.015, gap * 0.5 + 0.012));
      out.intensity = pinched ? 1 : 0.35;
      if (i === 0) this.feedback.left = out;
      else this.feedback.right = out;
    }
    const engaged = instrument ? driveFrame.pedal && driveFrame.selecting : frame.engaged;
    this.feedback.engage = dampTowards(
      this.feedback.engage,
      engaged ? 1 : 0,
      ENGAGE_HALF_LIFE,
      dt
    );
    this.updateMarkers(driveFrame);
    this.renderer.setFeedback(this.feedback);
  }

  /**
   * Spec §6 requires telling the user when fewer than two hands are visible.
   * Latched so it appears once after a couple of seconds rather than
   * flickering with every dropped frame, and it never stomps on a real error.
   */
  private updateHandHint(now: number): void {
    if (!this.tracker || this.source?.synthetic || this.persistentError) return;
    const missing = now - this.lastBothHandsAt > 2500;
    if (missing === this.handHintShown) return;
    this.handHintShown = missing;
    if (missing) {
      this.setStatus(
        "Fewer than two hands detected. Hold both hands up, palms toward the camera.",
        0
      );
    } else {
      this.hideStatus();
    }
  }

  /**
   * Diagnostic mode always shows landmarks; outside it, `showDebug` is the
   * user's own preference. Computing the union rather than writing the forced
   * value back into settings means a session that STARTS in diagnostic mode
   * cannot bake "overlay on" into the persisted preference.
   */
  private get overlayVisible(): boolean {
    return this.settings.showDebug || this.uiMode === "diagnostic";
  }

  private updateOverlay(frame: GestureFrame): void {
    if (!this.overlayVisible) {
      // Clear once on the way out, not every frame -- a full-canvas clearRect
      // at 2560x1440 is not free.
      if (this.overlayDrawn) {
        this.overlay.clear();
        this.overlayDrawn = false;
      }
      return;
    }
    this.overlayDrawn = true;
    this.overlayHands.length = 0;
    const slots = [
      { hand: this.assigned.left, label: "Slot L", color: HAND_COLORS.left, pinched: frame.leftPinched },
      { hand: this.assigned.right, label: "Slot R", color: HAND_COLORS.right, pinched: frame.rightPinched },
    ];
    for (const slot of slots) {
      if (!slot.hand) continue;
      this.overlayHands.push({
        label: `${slot.label} (${slot.hand.handedness})`,
        color: slot.color,
        confidence: slot.hand.confidence,
        pinched: slot.pinched,
        landmarks: slot.hand.landmarks.map((lm) => videoToDisplay(lm, this.crop)),
        indexTip: videoToDisplay(slot.hand.indexTip, this.crop),
        thumbTip: videoToDisplay(slot.hand.thumbTip, this.crop),
      });
    }

    this.overlay.draw(this.overlayHands);
  }

  // ------------------------------------------------------------ instrument

  /**
   * Fills the single reusable `InstrumentState` and hands it to the HUD. This
   * runs every frame, so it allocates nothing; the HUD and every component
   * under it change-detect before touching the DOM.
   */
  private updateInstrument(
    frame: GestureFrame,
    driveFrame: PlaneDriveFrame | null,
    now: number
  ): void {
    const ui = this.uiState;
    const instrument = driveFrame !== null;
    const slots = [this.assigned.left, this.assigned.right];
    const detected = (slots[0] ? 1 : 0) + (slots[1] ? 1 : 0);

    ui.mode = this.uiMode;
    ui.handsDetected = detected;
    ui.handsInFrame = this.handsInFrame;
    ui.tracking = !this.tracker
      ? "disabled"
      : detected >= 2
        ? "acquired"
        : detected === 1
          ? "partial"
          : "lost";

    // --- hand roles. In grip mode there is no selector/pedal split, so both
    // instruments report the raw slots and the gesture word says GRIP.
    const selector = instrument ? this.currentSelector : this.assigned.right;
    const pedal = instrument ? this.currentPedal : this.assigned.left;

    ui.select.present = selector !== null;
    ui.select.confidence = selector?.confidence ?? 0;
    ui.select.contact = instrument ? (driveFrame?.selecting ?? false) : frame.rightPinched;
    ui.select.gesture = !selector
      ? "—"
      : !instrument
        ? frame.rightPinched
          ? "PINCH"
          : "OPEN"
        : driveFrame?.selecting
          ? "TAP"
          : "OPEN";
    for (const finger of FINGER_NAMES) {
      ui.select.fingers[finger] = instrument && selector ? (driveFrame?.proximity[finger] ?? 0) : 0;
    }
    ui.select.proximity = Math.max(
      ui.select.fingers.index,
      ui.select.fingers.middle,
      ui.select.fingers.ring,
      ui.select.fingers.pinky
    );

    ui.drive.present = pedal !== null;
    ui.drive.confidence = pedal?.confidence ?? 0;
    ui.drive.contact = instrument
      ? (driveFrame?.pedal ?? false) || (driveFrame?.braking ?? false)
      : frame.leftPinched;
    ui.drive.gesture = !pedal
      ? "—"
      : !instrument
        ? frame.leftPinched
          ? "PINCH"
          : "OPEN"
        : driveFrame?.braking
          ? "FIST"
          : driveFrame?.pedal
            ? "PINCH"
            : "OPEN";
    ui.drive.proximity = ui.drive.contact ? 1 : 0;

    // --- planes. Velocity is whatever any control path has put into them.
    const keyboardVelocities = this.keyboard.planeVelocities;
    let speed = 0;
    for (const plane of PLANES) {
      const velocity = (driveFrame?.velocities[plane] ?? 0) + keyboardVelocities[plane];
      ui.velocities[plane] = velocity;
      speed = Math.max(speed, Math.abs(velocity));

      const info = PLANE_UI[plane];
      if (!instrument) {
        // Grip mode: taps do not apply, so a plane is either being driven by
        // the gesture this frame or it is not.
        ui.planes[plane] = Math.abs(frame.increments[plane]) > 1e-6 ? "active" : "available";
      } else if (!info.finger) {
        ui.planes[plane] = "unavailable";
      } else if (driveFrame?.touches[info.finger] || this.keyboard.latched.has(plane)) {
        ui.planes[plane] = "active";
      } else if (Math.abs(velocity) > 1e-3) {
        ui.planes[plane] = "spinning";
      } else if ((driveFrame?.proximity[info.finger] ?? 0) > 0.55) {
        ui.planes[plane] = "targeted";
      } else {
        ui.planes[plane] = "available";
      }
    }
    // Grip mode drives planes through increments rather than a velocity store,
    // so read the speed straight off this frame's motion.
    if (!instrument) {
      speed = 0;
      for (const plane of PLANES) {
        const rate = Math.abs(frame.increments[plane]) * this.renderFps;
        ui.velocities[plane] = frame.increments[plane] * this.renderFps;
        speed = Math.max(speed, rate);
      }
    }
    ui.speed = speed;
    ui.maxSpeed = this.settings.maxRate;

    ui.pedal = instrument ? (driveFrame?.pedal ?? false) : frame.engaged;
    ui.braking = driveFrame?.braking ?? false;
    ui.frozen = this.frozen;
    ui.condition = this.frozen
      ? "FROZEN"
      : ui.braking
        ? "BRAKE"
        : !instrument
          ? frame.engaged
            ? "GRIP"
            : speed > 1e-3
              ? "COAST"
              : "IDLE"
          : driveFrame?.pedal || this.keyboard.accelerating
            ? "ACCEL"
            : driveFrame?.selecting && pedal === null
              ? "HOLD"
              : speed > 1e-3
                ? "COAST"
                : "IDLE";

    ui.controlMode = this.settings.controlMode;
    ui.selectorSlot = this.settings.selectorSlot;
    ui.renderFps = this.renderFps;
    ui.trackingFps = this.tracker ? this.trackingFps : 0;
    ui.polytope = this.settings.polytope;
    ui.projection = this.settings.projection;
    ui.pinchEngage = this.settings.pinchEngageRatio;
    ui.pinchRelease = this.settings.pinchReleaseRatio;
    ui.detectionConfidence = this.settings.detectionConfidence;
    ui.trackingConfidence = this.settings.trackingConfidence;
    const buffer = this.renderer.drawingBufferSize;
    ui.resolution = `${buffer.width}x${buffer.height}`;
    ui.camera = this.source?.label ?? "no source";

    this.hud.update(ui);
    this.calibration.update(ui);

    // Console readouts are informational, not a frame path.
    if (now - this.lastSystemPush > 400) {
      this.lastSystemPush = now;
      this.controls?.updateSystem(ui);
    }
  }

  // -------------------------------------------------------------- settings

  private gestureOptions() {
    return {
      gains: {
        zw: this.settings.gainZW,
        xy: this.settings.gainXY,
        yw: this.settings.gainYW,
        xw: this.settings.gainXW,
        orbit: this.settings.orbitEnabled ? this.settings.gainOrbit : 0,
      },
      pinchEngageRatio: this.settings.pinchEngageRatio,
      pinchReleaseRatio: this.settings.pinchReleaseRatio,
      rateSmoothingAlpha: this.settings.rateSmoothingAlpha,
      inertia: this.settings.inertiaEnabled,
      spinFriction: this.settings.spinFriction,
    };
  }

  private driveOptions() {
    return {
      holdRate: this.settings.holdRate,
      pedalAccel: this.settings.pedalAccel,
      maxRate: this.settings.maxRate,
      friction: this.settings.driveFriction,
      // The pedal reuses the grip pinch thresholds, so tuning them once
      // covers both modes.
      pinchEngageRatio: this.settings.pinchEngageRatio,
      pinchReleaseRatio: this.settings.pinchReleaseRatio,
    };
  }

  private applyPolytope(): void {
    // The dense polychora are unreadable in perspective (spec §4.2): selecting
    // one forces stereographic. The user can still switch back for the sparse
    // shapes.
    if (STEREOGRAPHIC_ONLY[this.settings.polytope] && this.settings.projection !== "stereographic") {
      this.settings.projection = "stereographic";
      this.controls?.refresh();
    }
    this.renderer.setPolytope(buildPolytope(this.settings.polytope));
    this.renderer.setProjection(this.settings.projection);
  }

  private applySettings(changedKey?: keyof Settings): void {
    if (changedKey === "controlMode") {
      // Neither scheme may replay motion accumulated under the other.
      this.gesture.reset();
      this.planeDrive.reset();
      this.currentSelector = null;
      this.currentPedal = null;
      this.setStatus(
        this.settings.controlMode === "instrument"
          ? "Instrument mode: tap thumb to a finger to pick a plane; pinch the other hand to accelerate; fist to stop."
          : "Grip-and-pull mode: pinch BOTH hands and pull them apart.",
        4500
      );
    }
    if (changedKey === "polytope" || changedKey === "projection") {
      this.applyPolytope();
      if (changedKey === "polytope") {
        this.setStatus(`${this.settings.polytope} (${this.settings.projection})`, 2000);
      }
    }
    if (changedKey === "maxPixelRatio" || changedKey === "outputAspect") this.handleResize();

    // The clutch chatters if release <= engage; repair live edits too.
    if (this.settings.pinchReleaseRatio <= this.settings.pinchEngageRatio) {
      this.settings.pinchReleaseRatio = this.settings.pinchEngageRatio + 0.1;
      this.controls?.refresh();
    }

    setSlotAlpha(this.slotLeft, this.settings.smoothingAlpha);
    setSlotAlpha(this.slotRight, this.settings.smoothingAlpha);
    this.gesture.setOptions(this.gestureOptions());
    this.planeDrive.setOptions(this.driveOptions());
    // The keyboard fallback borrows the same motion feel as the pedal.
    this.keyboard.setOptions({
      pedalAccel: this.settings.pedalAccel,
      maxRate: this.settings.maxRate,
      friction: this.settings.driveFriction,
    });

    if (
      this.tracker &&
      (changedKey === "detectionConfidence" ||
        changedKey === "trackingConfidence" ||
        changedKey === "maxHands")
    ) {
      void this.tracker.setOptions(this.trackerOptions());
    }

    this.renderer.setStyle({
      tubeRadius: this.settings.tubeRadius,
      glowStrength: this.settings.glowStrength,
      chromaSplit: this.settings.chromaSplit,
      hueBase: this.settings.hueBase,
      hueRange: this.settings.hueRange,
      objectScale: this.settings.objectScale,
      objectCenterY: this.settings.objectCenterY,
      accentColor: this.settings.accentColor,
      edgeSmoothness: this.settings.edgeSmoothness,
    });
    this.queueSave();
  }

  /** Dragging a slider fires continuously; only the settled value is persisted. */
  private queueSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      saveSettings(this.settings);
    }, 300);
  }

  private resetSettings(): void {
    // Resetting the instrument should not make it re-teach itself.
    const onboardingDone = this.settings.onboardingDone;
    clearSettings();
    Object.assign(this.settings, this.defaults, { onboardingDone });
    this.keyboard.reset();
    this.hud.setLatched(this.keyboard.latched);
    this.controls?.refresh();
    this.applyUiMode(this.settings.uiMode, false);
    this.handleResize();
    this.applyPolytope();
    this.applySettings();
    this.setStatus("Settings reset to defaults.", 2000);
  }

  private resetOrientation(): void {
    this.rotation = identity();
    this.framesSinceRenormalize = 0;
    this.setStatus("Orientation reset.", 1500);
  }

  /**
   * Picks the layout band before the stage is measured, so a rail collapsing
   * and the composition being resized happen in the same pass. See the
   * responsive block in styles.css for what each band does.
   */
  private applyLayout(): void {
    const width = window.innerWidth;
    const layout =
      width >= 2200 ? "ultrawide" : width >= 1400 ? "full" : width >= 1180 ? "compact" : "narrow";
    const previous = this.el.shell.dataset.layout;
    if (previous === layout) return;
    this.el.shell.dataset.layout = layout;

    // A rail that has just turned into a drawer sits OVER the composition, so
    // it starts closed: on a tablet the two drawers together would otherwise
    // hide all but a sliver of the stage. Going the other way, a rail that
    // docks again gets its space back and reopens.
    const leftWasDrawer = previous === "narrow";
    const rightWasDrawer = previous === "narrow" || previous === "compact";
    if (previous !== undefined) {
      if (this.leftRailIsDrawer() !== leftWasDrawer) {
        this.setRailLeftOpen(!this.leftRailIsDrawer(), false);
      }
      if (this.consoleIsDrawer() !== rightWasDrawer) {
        this.setConsoleVisible(this.consoleDefaultVisible(), false);
      }
    }
  }

  /** In the narrow band the instrumentation rail overlays the stage. */
  private leftRailIsDrawer(): boolean {
    return this.el.shell.dataset.layout === "narrow";
  }

  /** In the compact and narrow bands the console overlays the stage. */
  private consoleIsDrawer(): boolean {
    const layout = this.el.shell.dataset.layout;
    return layout === "narrow" || layout === "compact";
  }

  /** Docked: open unless the user hid it with G. Drawer: closed until asked. */
  private consoleDefaultVisible(): boolean {
    return !this.guiHiddenByUser && !this.consoleIsDrawer();
  }

  private handleResize = (): void => {
    this.applyLayout();
    // The canvas IS the composition: at a fixed output aspect it becomes a
    // centred box of that shape, so `captureStream()` records 9:16 directly.
    //
    // It is measured against the STAGE, not the window, so opening a rail
    // reframes the composition instead of cropping it, and collapsing one
    // gives the space back to the aperture.
    const stageWidth = this.el.stage.clientWidth || window.innerWidth;
    const stageHeight = this.el.stage.clientHeight || window.innerHeight;
    const { width, height } = computeFrameSize(
      stageWidth,
      stageHeight,
      OUTPUT_ASPECTS[this.settings.outputAspect] ?? null
    );
    const ratio = Math.min(window.devicePixelRatio || 1, this.settings.maxPixelRatio);
    this.renderer.resize(width, height, ratio);
    this.overlay.resize(width, height, ratio);
    this.el.aperture.style.width = `${width}px`;
    this.el.aperture.style.height = `${height}px`;
    this.el.sceneCanvas.style.width = `${width}px`;
    this.el.sceneCanvas.style.height = `${height}px`;
    this.updateCrop();
  };

  private handleFullscreenChange = (): void => {
    // Hide in fullscreen; on the way out, only restore the panel if the user
    // had not deliberately hidden it with `G`.
    const fullscreen = document.fullscreenElement !== null;
    this.setConsoleVisible(fullscreen ? false : this.consoleDefaultVisible(), false);
  };

  // -------------------------------------------------------- interface modes

  /**
   * Normal / presentation / diagnostic (DESIGN.md §6). Diagnostic force-enables
   * the landmark overlay and restores the user's own choice on the way out, so
   * normal mode never inherits a debug look.
   */
  private applyUiMode(mode: UiMode, announce: boolean): void {
    this.uiMode = mode;
    this.settings.uiMode = mode;
    this.el.shell.dataset.mode = mode;
    this.hud.setMode(mode);
    // refresh() repaints every control from settings, so the mode-specific
    // overrides in setUiMode() have to land after it.
    this.controls?.refresh();
    this.controls?.setUiMode(mode);

    // Presentation hides the console outright; leaving it restores the rail
    // unless the user had deliberately hidden it.
    if (mode === "presentation") {
      this.setConsoleVisible(false, false);
      this.setRailLeftOpen(false, false);
      this.setShortcuts(false);
    } else {
      this.setConsoleVisible(this.consoleDefaultVisible(), false);
      this.setRailLeftOpen(!this.leftRailIsDrawer(), false);
    }
    this.el.railRightTab.hidden = mode === "presentation";
    this.el.railLeftTab.hidden = mode === "presentation";

    if (announce) {
      this.setStatus(
        mode === "presentation"
          ? "Presentation mode. Press X to bring the instrumentation back."
          : mode === "diagnostic"
            ? "Diagnostic mode: landmarks, raw confidences and frame rates."
            : "Normal mode.",
        2500
      );
    }
    this.queueSave();
    this.handleResize();
  }

  private cycleUiMode(target: UiMode): void {
    this.applyUiMode(this.uiMode === target ? "normal" : target, true);
  }

  private setRailLeftOpen(open: boolean, persist = true): void {
    this.railLeftOpen = open;
    this.el.railLeft.dataset.open = String(open);
    this.el.railLeft.inert = !open;
    this.el.railLeftTab.setAttribute("aria-expanded", String(open));
    if (persist) this.handleResize();
  }

  /**
   * Single path for console visibility, so the tab's `aria-expanded` can never
   * drift from the drawer's real state. `remember` records a deliberate user
   * hide, which fullscreen and mode changes must not undo.
   */
  private setConsoleVisible(visible: boolean, remember: boolean): void {
    if (remember) this.guiHiddenByUser = !visible;
    this.controls?.setVisible(visible);
    this.el.railRightTab.setAttribute("aria-expanded", String(visible));
    this.handleResize();
  }

  private toggleConsole(): void {
    if (!this.controls) return;
    this.setConsoleVisible(!this.controls.visible, true);
  }

  private setShortcuts(open: boolean): void {
    this.el.shortcutsEl.hidden = !open;
    if (open) this.el.shortcutsClose.focus();
  }

  private handleActivity = (): void => this.hud.noteActivity();

  private handleBlur = (): void => {
    // A held W or S must not stick when the window loses focus.
    this.keyboard.accelerating = false;
    this.keyboard.braking = false;
  };

  // -------------------------------------------------------------- commands

  private async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
        // A phone going fullscreen wants the wide frame too; the lock only
        // takes on Android and is silently refused elsewhere.
        if (this.device.handheld) void tryLockLandscape();
      }
    } catch {
      this.setStatus("Fullscreen was refused by the browser.", 2500);
    }
  }

  private async toggleRecording(): Promise<void> {
    if (!CanvasRecorder.supported) {
      this.setStatus("This browser cannot record the canvas. Use OBS Window Capture.", 4000, true);
      return;
    }
    if (this.recorder.recording) {
      const name = await this.recorder.stop();
      this.el.recIndicator.hidden = true;
      this.setStatus(name ? `Saved ${name} to your downloads.` : "Recording produced no data.", 4000);
    } else {
      try {
        this.recorder.start();
        this.el.recIndicator.hidden = false;
        this.setStatus("Recording the canvas locally.", 2500);
      } catch (err) {
        this.reportError(err);
      }
    }
    this.controls?.setRecording(this.recorder.recording);
  }

  private updateRecordingIndicator(): void {
    if (!this.recorder.recording) return;
    const total = Math.floor(this.recorder.elapsed);
    const mm = Math.floor(total / 60);
    const ss = String(total % 60).padStart(2, "0");
    this.el.recTime.textContent = `${mm}:${ss}`;
  }

  // ----------------------------------------------------------- keyboard/UI

  private handleKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    // Never steal keys from the console's text and number fields.
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable)
    ) {
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    this.hud.noteActivity();

    // `?` opens the shortcut sheet, Escape closes whatever is open.
    if (event.key === "?") {
      event.preventDefault();
      // `hidden` is boolean | "until-found" in the current DOM lib.
      this.setShortcuts(Boolean(this.el.shortcutsEl.hidden));
      return;
    }
    if (event.key === "Escape") {
      if (!this.el.shortcutsEl.hidden) {
        this.setShortcuts(false);
        return;
      }
      if (this.calibration.running) {
        this.calibration.stop();
        return;
      }
      if (this.uiMode !== "normal") {
        this.applyUiMode("normal", true);
        return;
      }
      return;
    }

    const key = event.key.toLowerCase();

    // Hands-free drive: hold W to accelerate the latched planes, S to brake.
    // Repeat events are ignored so holding does not thrash the flag.
    if (key === "w" || key === "s") {
      event.preventDefault();
      if (!event.repeat) {
        if (key === "w") this.keyboard.accelerating = true;
        else this.keyboard.braking = true;
        if (this.keyboard.latched.size === 0 && key === "w") {
          this.setStatus(
            "No plane latched. Pick one in the rotation-plane matrix (arrow keys, then Space).",
            3500
          );
        }
      }
      return;
    }

    // 1-6 select the polytope in spec order.
    const index = Number.parseInt(key, 10);
    if (index >= 1 && index <= POLYTOPE_NAMES.length) {
      this.settings.polytope = POLYTOPE_NAMES[index - 1] as PolytopeName;
      this.controls?.refresh();
      this.applySettings("polytope");
      return;
    }

    switch (key) {
      case "f":
        void this.toggleFullscreen();
        break;
      case "d":
        // Diagnostic mode owns the landmark overlay now; toggling the mode is
        // what people actually wanted when they hit D.
        this.cycleUiMode("diagnostic");
        break;
      case "x":
        this.cycleUiMode("presentation");
        break;
      case "g":
        this.toggleConsole();
        break;
      case "r":
        this.resetSettings();
        break;
      case "o":
        this.resetOrientation();
        break;
      case "v":
        void this.toggleRecording();
        break;
      case "p":
        this.settings.projection =
          this.settings.projection === "perspective" ? "stereographic" : "perspective";
        this.controls?.refresh();
        this.applySettings("projection");
        break;
      case "m":
        this.settings.controlMode =
          this.settings.controlMode === "instrument" ? "grip" : "instrument";
        this.controls?.refresh();
        this.applySettings("controlMode");
        break;
      case " ":
        event.preventDefault();
        this.frozen = !this.frozen;
        this.setStatus(this.frozen ? "Rotation frozen." : "Rotation live.", 1500);
        break;
      default:
        return;
    }
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    const key = event.key.toLowerCase();
    if (key === "w") this.keyboard.accelerating = false;
    else if (key === "s") this.keyboard.braking = false;
  };

  private setStatus(message: string, timeoutMs = 3500, isError = false): void {
    const el = this.el.statusEl;
    el.textContent = message;
    el.classList.toggle("error", isError);
    el.classList.add("visible");
    this.persistentError = isError && timeoutMs === 0;
    if (this.statusTimer !== null) clearTimeout(this.statusTimer);
    if (timeoutMs > 0) {
      this.statusTimer = window.setTimeout(() => el.classList.remove("visible"), timeoutMs);
    }
  }

  private hideStatus(): void {
    if (this.statusTimer !== null) clearTimeout(this.statusTimer);
    this.statusTimer = null;
    this.el.statusEl.classList.remove("visible");
  }

  private reportError(err: unknown): void {
    const message =
      err instanceof AppError
        ? err.message
        : err instanceof Error
          ? err.message
          : "An unexpected error occurred.";
    this.setStatus(message, 0, true);
    console.error(err);
  }

  /** Exposed for the debug overlay and tests. */
  get lastFrame(): GestureFrame | null {
    return this.lastGestureFrame;
  }
}

/**
 * Scripted hands for synthetic mode, in video-normalized space. They pinch,
 * pull apart, drift and release on a cycle, so the whole pipeline -- clutch,
 * gesture deltas, rotation, occlusion hulls, engage feedback -- runs with no
 * webcam and no hands.
 */
function syntheticHands(nowMs: number): AssignedHands {
  const t = nowMs / 1000;
  const cycle = t % 8;
  // Pinched during seconds 1..5 of each 8-second cycle. In instrument mode
  // this doubles as pedal-down (pedal hand) + index tap = ZW (selector hand).
  const pinched = cycle > 1 && cycle < 5;
  // Late in the released window the selector hand (video-left slot, which
  // the mirror puts on screen-right) taps its middle finger to the thumb,
  // exercising tap detection and the YW fingertip label without a webcam.
  const tapDemo = cycle > 5.4;
  // Separation breathes while pinched: the ZW inside-out gesture.
  const spread = 0.18 + (pinched ? 0.1 * Math.sin((cycle - 1) * 1.2) : 0);
  const lift = 0.04 * Math.sin(t * 0.7);

  const make = (side: -1 | 1): TrackedHand => {
    const cx = 0.5 + side * spread;
    const cy = 0.62 + lift * side;
    const pinchGap = pinched ? 0.018 : 0.09;
    const thumbTip: Point2D = { x: cx - pinchGap / 2, y: cy };
    const indexTip: Point2D = { x: cx + pinchGap / 2, y: cy };
    const wrist: Point2D = { x: cx, y: cy + 0.16 };
    // A hand-shaped cloud of 21 landmarks around the palm for the hull.
    const landmarks: Point2D[] = [];
    for (let i = 0; i < 21; i += 1) {
      const angle = (i / 21) * Math.PI * 2;
      landmarks.push({
        x: cx + 0.055 * Math.cos(angle),
        y: cy + 0.07 + 0.075 * Math.sin(angle),
      });
    }
    landmarks[0] = wrist;
    landmarks[4] = thumbTip;
    landmarks[8] = indexTip;
    // Knuckle row and clearly-extended fingertips, so the finger-hold layer
    // reads this scripted hand as open rather than as random folds.
    landmarks[5] = { x: cx - 0.03, y: cy + 0.04 };
    landmarks[9] = { x: cx - 0.01, y: cy + 0.045 };
    landmarks[13] = { x: cx + 0.01, y: cy + 0.045 };
    landmarks[17] = { x: cx + 0.05, y: cy + 0.05 };
    landmarks[12] =
      tapDemo && side === -1
        ? { x: thumbTip.x + 0.008, y: thumbTip.y } // tip on the thumb: tapped
        : { x: cx - 0.01, y: cy - 0.055 };
    landmarks[16] = { x: cx + 0.01, y: cy - 0.055 };
    landmarks[20] = { x: cx + 0.05, y: cy - 0.05 };
    return {
      handedness: side === -1 ? "Left" : "Right",
      confidence: 1,
      indexTip,
      thumbTip,
      wrist,
      palmCenter: { x: cx, y: cy + 0.08 },
      span: 0.115,
      landmarks,
    };
  };

  return { left: make(-1), right: make(1) };
}
