/**
 * Device profile: the one place that decides whether this is a handheld
 * (phone / tablet) or a desk machine, and what follows from that.
 *
 * The signal is `(hover: none) and (pointer: coarse)` -- "the primary input is
 * a finger" -- not the user agent. iPadOS Safari asks for the desktop site by
 * default, so its UA string is a Mac's, but its media features are still a
 * tablet's. A touchscreen laptop with a mouse attached reports `hover: hover`
 * and stays on the desktop profile, which is right: it has a desk-sized
 * screen and a landscape webcam.
 *
 * What changes on a handheld (see `deviceDefaults`):
 *
 *   - The composition fills the stage instead of defaulting to a 9:16 box.
 *     The 9:16 default exists so a desktop creator records a phone-shaped
 *     clip; on an actual phone or tablet it shrinks the viewport to a
 *     letterboxed sliver in the middle of a screen that IS the output.
 *   - Rendering caps at 1x pixel ratio. Hand-tracking inference is the
 *     frame-rate bottleneck on a mobile GPU, and a 3x display buys nothing
 *     the glow does not blur away.
 *
 * Landscape is also strongly preferred on a handheld: the front camera's
 * frame is wide, so a portrait viewport cover-crops the sides -- exactly where
 * the two hands are. `watchDevice` exposes the orientation as an attribute
 * so the boot screen and the stage can hint at it in CSS.
 */

import type { Settings } from "./settings.ts";

export type DeviceProfile = {
  /** Primary input is touch: a phone or a tablet. */
  handheld: boolean;
};

export type Orientation = "portrait" | "landscape";

const HANDHELD_QUERY = "(hover: none) and (pointer: coarse)";
const PORTRAIT_QUERY = "(orientation: portrait)";

function media(query: string): MediaQueryList | null {
  return typeof matchMedia === "function" ? matchMedia(query) : null;
}

/**
 * `?touch=1` forces the handheld profile so it can be exercised in a desktop
 * browser -- the same idea as `?synthetic=1` for the camera.
 */
export function detectDevice(search: string = location.search): DeviceProfile {
  const forced = new URLSearchParams(search).get("touch");
  if (forced === "1") return { handheld: true };
  if (forced === "0") return { handheld: false };
  return { handheld: media(HANDHELD_QUERY)?.matches ?? false };
}

export function currentOrientation(): Orientation {
  return media(PORTRAIT_QUERY)?.matches ? "portrait" : "landscape";
}

/** Settings whose factory value depends on the device. Pure; unit-tested. */
export function deviceDefaults(profile: DeviceProfile): Partial<Settings> {
  if (!profile.handheld) return {};
  return { outputAspect: "fill", maxPixelRatio: 1 };
}

/**
 * Publishes the profile and the live orientation on `<html>` as
 * `data-handheld` and `data-orientation`, so the boot screen (outside the
 * shell) and the stage (inside it) can both react in CSS without a second
 * source of truth. Returns a disposer.
 */
export function watchDevice(
  profile: DeviceProfile,
  root: HTMLElement = document.documentElement
): () => void {
  root.dataset.handheld = String(profile.handheld);
  const portrait = media(PORTRAIT_QUERY);
  const apply = (): void => {
    root.dataset.orientation = portrait?.matches ? "portrait" : "landscape";
  };
  apply();
  portrait?.addEventListener("change", apply);
  return () => portrait?.removeEventListener("change", apply);
}

/**
 * Best-effort landscape lock. Only Android Chrome honours it, and only once
 * the document is fullscreen; everywhere else it throws and the hint stays
 * up instead. Never awaited by the caller for that reason.
 */
export async function tryLockLandscape(): Promise<boolean> {
  const orientation = screen.orientation as ScreenOrientation & {
    lock?(mode: string): Promise<void>;
  };
  if (typeof orientation?.lock !== "function") return false;
  try {
    await orientation.lock("landscape");
    return true;
  } catch {
    return false;
  }
}
