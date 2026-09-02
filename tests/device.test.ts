import { describe, expect, it } from "vitest";
import { detectDevice, deviceDefaults } from "../src/device.ts";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../src/settings.ts";

describe("deviceDefaults", () => {
  it("leaves a desk machine on the factory 9:16 composition", () => {
    expect(deviceDefaults({ handheld: false })).toEqual({});
    expect(DEFAULT_SETTINGS.outputAspect).toBe("9:16");
  });

  it("fills the stage and caps the pixel ratio on a handheld", () => {
    const overrides = deviceDefaults({ handheld: true });
    expect(overrides.outputAspect).toBe("fill");
    expect(overrides.maxPixelRatio).toBe(1);
    // Nothing else changes: a phone still gets the same instrument.
    expect(Object.keys(overrides).sort()).toEqual(["maxPixelRatio", "outputAspect"]);
  });

  it("only touches keys that exist in Settings", () => {
    for (const key of Object.keys(deviceDefaults({ handheld: true }))) {
      expect(key in DEFAULT_SETTINGS).toBe(true);
    }
  });
});

describe("detectDevice", () => {
  it("honours the ?touch override in either direction", () => {
    expect(detectDevice("?touch=1").handheld).toBe(true);
    expect(detectDevice("?synthetic=1&touch=1").handheld).toBe(true);
    expect(detectDevice("?touch=0").handheld).toBe(false);
  });

  it("falls back to desktop where matchMedia does not exist", () => {
    // vitest runs these in node: no matchMedia, so the profile must not throw.
    expect(detectDevice("").handheld).toBe(false);
  });
});

/** Minimal localStorage so the persistence path runs under node. */
function fakeStorage(entry: Record<string, unknown> | null): void {
  const store = new Map<string, string>();
  if (entry) store.set("hand-controlled-4d/settings/v1", JSON.stringify(entry));
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
}

describe("loadSettings with device defaults", () => {
  const handheld = { ...DEFAULT_SETTINGS, ...deviceDefaults({ handheld: true }) };

  it("ignores the desktop composition from an entry saved before device profiles", () => {
    // What finishing the guide on a 1.1.0 build persisted on an iPad.
    fakeStorage({ ...DEFAULT_SETTINGS, onboardingDone: true, polytope: "24-cell" });
    const settings = loadSettings(handheld);
    expect(settings.outputAspect).toBe("fill");
    expect(settings.maxPixelRatio).toBe(1);
    // Everything else from that entry still counts.
    expect(settings.onboardingDone).toBe(true);
    expect(settings.polytope).toBe("24-cell");
    fakeStorage(null);
  });

  it("honours a composition the user chose on a handheld", () => {
    fakeStorage({ ...handheld, outputAspect: "9:16", profileVersion: 1 });
    expect(loadSettings(handheld).outputAspect).toBe("9:16");
    fakeStorage(null);
  });

  it("stamps the profile version on save so the migration runs once", () => {
    fakeStorage(null);
    saveSettings(handheld);
    const raw = localStorage.getItem("hand-controlled-4d/settings/v1");
    expect(JSON.parse(raw ?? "{}").profileVersion).toBe(1);
    // A desk machine reading that entry back is unaffected: no key differs
    // from DEFAULT_SETTINGS there, so nothing is skipped.
    expect(loadSettings(DEFAULT_SETTINGS).outputAspect).toBe("fill");
    fakeStorage(null);
  });

  it("starts from the device's factory state when nothing is stored", () => {
    const defaults = { ...DEFAULT_SETTINGS, ...deviceDefaults({ handheld: true }) };
    const settings = loadSettings(defaults);
    expect(settings.outputAspect).toBe("fill");
    expect(settings.maxPixelRatio).toBe(1);
    expect(settings.polytope).toBe(DEFAULT_SETTINGS.polytope);
  });
});
