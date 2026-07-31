/**
 * Output framing.
 *
 * By default the canvas fills the window. For social work you want the canvas to
 * BE the composition instead -- a fixed-aspect box centred in the window -- so
 * `canvas.captureStream()` records exactly 9:16 (or 1:1, or 4:5) with no
 * cropping in post, and so the hand geometry maps into the frame you are
 * actually going to publish.
 */

export type OutputAspect = "fill" | "16:9" | "4:5" | "1:1" | "9:16";

/** width / height. `null` means "match the window". */
export const OUTPUT_ASPECTS: Record<OutputAspect, number | null> = {
  fill: null,
  "16:9": 16 / 9,
  "4:5": 4 / 5,
  "1:1": 1,
  "9:16": 9 / 16,
};

export function isOutputAspect(value: string): value is OutputAspect {
  // hasOwn, not `in`: `in` walks the prototype chain, so "toString" would pass.
  return Object.hasOwn(OUTPUT_ASPECTS, value);
}

export type FrameSize = { width: number; height: number };

/**
 * Largest box of the given aspect that fits inside the window (contain-fit),
 * centred. A `null` ratio returns the window itself.
 */
export function computeFrameSize(
  windowWidth: number,
  windowHeight: number,
  ratio: number | null
): FrameSize {
  const w = Number.isFinite(windowWidth) ? Math.max(1, windowWidth) : 1;
  const h = Number.isFinite(windowHeight) ? Math.max(1, windowHeight) : 1;
  if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) {
    return { width: Math.floor(w), height: Math.floor(h) };
  }
  const windowRatio = w / h;
  const width = windowRatio > ratio ? h * ratio : w;
  const height = windowRatio > ratio ? h : w / ratio;
  return { width: Math.max(1, Math.floor(width)), height: Math.max(1, Math.floor(height)) };
}
