/**
 * Optional in-browser capture of the rendered canvas. OBS Window Capture is
 * still the recommended route (see README); this exists for a quick clip
 * without leaving the page. Nothing is uploaded -- the blob is handed straight
 * to a download link.
 */

const CANDIDATE_TYPES = [
  "video/mp4;codecs=avc1",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const type of CANDIDATE_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

export class CanvasRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private startedAt = 0;

  constructor(private canvas: HTMLCanvasElement, private fps = 60) {}

  static get supported(): boolean {
    return pickMimeType() !== null && typeof HTMLCanvasElement.prototype.captureStream === "function";
  }

  get recording(): boolean {
    return this.recorder !== null && this.recorder.state === "recording";
  }

  /** Seconds since recording started, for the on-screen indicator. */
  get elapsed(): number {
    return this.recording ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  start(): void {
    if (this.recording) return;
    const mimeType = pickMimeType();
    if (!mimeType) throw new Error("This browser cannot record canvas video.");

    this.stream = this.canvas.captureStream(this.fps);
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, { mimeType, videoBitsPerSecond: 12_000_000 });
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.start(1000);
    this.startedAt = performance.now();
  }

  /** Stops and triggers a local download. Resolves with the file name. */
  async stop(): Promise<string | null> {
    const recorder = this.recorder;
    const stream = this.stream;
    const chunks = this.chunks;
    if (!recorder || recorder.state === "inactive") return null;

    // Detach everything BEFORE awaiting. Otherwise a second `V` press during the
    // flush starts a new recording, and this continuation then stops the new
    // stream's tracks and nulls the new recorder -- a recording that shows as
    // running but captures nothing.
    this.recorder = null;
    this.stream = null;
    this.chunks = [];

    const finished = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.stop();
    await finished;

    for (const track of stream?.getTracks() ?? []) track.stop();

    if (chunks.length === 0) return null;
    const type = recorder.mimeType || "video/webm";
    const blob = new Blob(chunks, { type });

    const extension = type.includes("mp4") ? "mp4" : "webm";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = `4d-rotation-${stamp}.${extension}`;

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return name;
  }

  dispose(): void {
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
  }
}
