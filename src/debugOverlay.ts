/**
 * 2D overlay drawn on top of the WebGL canvas: the landmark cloud and the
 * pinch pair, per hand. Diagnostic only -- it lives on a separate canvas and is
 * NOT part of the recording.
 *
 * It consumes DISPLAY-space points, exactly like the renderer does. If the
 * markers do not sit on the visible fingertips, the coordinate contract in
 * coords.ts is broken -- surfacing that is the point of this overlay, and the
 * reason it has to be drawn in the composition rather than in the DOM.
 *
 * The frame counters, plane bars and camera readout that used to be painted
 * here now live in the instrumentation rail (`ui/telemetry.ts`,
 * `ui/planeMatrix.ts`). They were baked into recordings and made normal mode
 * look like a debug tool; as DOM they are selectable, screen-readable, and
 * absent from the captured frame.
 */

import type { Point2D } from "./types.ts";

export type OverlayHand = {
  label: string;
  color: string;
  confidence: number;
  pinched: boolean;
  /** All 21 landmarks, display space. */
  landmarks: Point2D[];
  indexTip: Point2D;
  thumbTip: Point2D;
};

export class DebugOverlay {
  private ctx: CanvasRenderingContext2D | null;
  private width = 0;
  private height = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d");
  }

  resize(cssWidth: number, cssHeight: number, pixelRatio: number): void {
    this.canvas.width = Math.round(cssWidth * pixelRatio);
    this.canvas.height = Math.round(cssHeight * pixelRatio);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.width = this.canvas.width;
    this.height = this.canvas.height;
    this.ctx?.setTransform(1, 0, 0, 1, 0, 0);
  }

  clear(): void {
    this.ctx?.clearRect(0, 0, this.width, this.height);
  }

  draw(hands: readonly OverlayHand[]): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.clear();

    const scale = this.height / 720; // keep the overlay legible at any size

    for (const hand of hands) {
      ctx.save();
      ctx.strokeStyle = hand.color;
      ctx.fillStyle = hand.color;

      // Landmark cloud.
      ctx.globalAlpha = 0.65;
      for (const lm of hand.landmarks) {
        ctx.beginPath();
        ctx.arc(lm.x * this.width, lm.y * this.height, 2.2 * scale, 0, Math.PI * 2);
        ctx.fill();
      }

      // Pinch pair: thumb tip to index tip, highlighted when engaged.
      const thumb = { x: hand.thumbTip.x * this.width, y: hand.thumbTip.y * this.height };
      const tip = { x: hand.indexTip.x * this.width, y: hand.indexTip.y * this.height };
      ctx.globalAlpha = 1;
      ctx.lineWidth = Math.max(1, (hand.pinched ? 3 : 1.5) * scale);
      ctx.beginPath();
      ctx.moveTo(thumb.x, thumb.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.stroke();

      ctx.font = `${Math.round(13 * scale)}px "Roboto Mono", Consolas, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(
        `${hand.label} ${(hand.confidence * 100).toFixed(0)}%${hand.pinched ? " PINCH" : ""}`,
        tip.x,
        tip.y - 18 * scale
      );
      ctx.restore();
    }
  }
}
