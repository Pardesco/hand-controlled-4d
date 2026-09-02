// Self-hosted type. A Google Fonts <link> would put a network request in an
// app whose whole promise is that nothing leaves the machine.
import "@fontsource-variable/saira/wght.css";
import "@fontsource/saira-semi-condensed/latin-600.css";
import "@fontsource-variable/roboto-mono/wght.css";

// Cascade order: tokens, then base/shell, then components.
import "./ui/tokens.css";
import "./styles.css";
import "./ui/instrument.css";

import { App, type AppElements } from "./app.ts";
import { detectDevice, watchDevice } from "./device.ts";

// Published on <html> before anything renders, so the boot screen can already
// show the landscape hint on a portrait phone.
watchDevice(detectDevice());

// The in-stage rotate hint is CSS-driven; a tap retires it for this visit.
const orientationHint = document.getElementById("orientation-hint");
orientationHint?.addEventListener("click", () => {
  orientationHint.hidden = true;
});

function required<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in index.html`);
  return el as T;
}

const railLeft = required("rail-left");
const railLeftScroll = railLeft.querySelector<HTMLElement>(".rail__scroll");
if (!railLeftScroll) throw new Error("Missing .rail__scroll in #rail-left");

const elements: AppElements = {
  shell: required("shell"),
  stage: required("stage"),
  aperture: required("aperture"),
  sceneCanvas: required<HTMLCanvasElement>("scene"),
  overlayCanvas: required<HTMLCanvasElement>("overlay"),
  bandTop: required("band-top"),
  bandBottom: required("band-bottom"),
  railLeft,
  railLeftScroll,
  railLeftTab: required<HTMLButtonElement>("rail-left-tab"),
  railRight: required("rail-right"),
  railRightTab: required<HTMLButtonElement>("rail-right-tab"),
  statusEl: required("status"),
  bootEl: required("boot"),
  bootStatusEl: required("boot-status"),
  recIndicator: required("rec-indicator"),
  recTime: required("rec-time"),
  onboardingMount: required("onboarding-mount"),
  shortcutsEl: required("shortcuts"),
  shortcutsClose: required<HTMLButtonElement>("shortcuts-close"),
};

const startButton = required<HTMLButtonElement>("start");
const syntheticButton = required<HTMLButtonElement>("start-synthetic");

let app: App | null = null;

async function boot(synthetic: boolean): Promise<void> {
  if (app) return;
  startButton.disabled = true;
  syntheticButton.disabled = true;
  try {
    app = new App(elements);
    await app.start(synthetic);
  } catch (err) {
    // No WebGL, permission denied, camera busy... Tear the half-built instance
    // down (it has already registered window listeners) and hand the boot
    // screen back so the user can retry or fall back to synthetic mode.
    app?.dispose();
    app = null;
    if (!elements.statusEl.textContent) {
      elements.statusEl.textContent =
        err instanceof Error ? err.message : "The application failed to start.";
    }
    elements.statusEl.classList.add("visible", "error");
    elements.bootEl.classList.remove("hidden");
    startButton.disabled = false;
    syntheticButton.disabled = false;
    console.error(err);
  }
}

startButton.addEventListener("click", () => void boot(false));
syntheticButton.addEventListener("click", () => void boot(true));

// `?synthetic=1` boots straight into the no-webcam verification mode.
if (new URLSearchParams(location.search).get("synthetic") === "1") {
  void boot(true);
}
