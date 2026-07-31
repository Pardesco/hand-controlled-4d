/** Webcam acquisition, plus a synthetic source so the app is testable without one. */

export type AppErrorCode =
  | "no-webcam"
  | "permission-denied"
  | "stream-failed"
  | "unsupported-browser"
  | "webgl-unavailable"
  | "model-load-failed";

export class AppError extends Error {
  readonly code: AppErrorCode;
  constructor(code: AppErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}

export type VideoSource = {
  video: HTMLVideoElement;
  label: string;
  synthetic: boolean;
  stop(): void;
};

export type CameraRequest = {
  deviceId?: string;
  width?: number;
  height?: number;
};

export async function listVideoDevices(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "videoinput");
}

function makeVideoElement(): HTMLVideoElement {
  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;
  return video;
}

async function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2 && video.videoWidth > 0) return;
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new AppError("stream-failed", "The video stream could not be decoded."));
    };
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", done);
      video.removeEventListener("error", fail);
    };
    video.addEventListener("loadedmetadata", done, { once: true });
    video.addEventListener("error", fail, { once: true });
  });
}

/**
 * Metadata arriving is not the same as a frame arriving: a stream can report its
 * dimensions while the first frame is still being decoded, and on a cold start
 * (large WASM compile hogging the main thread) that gap is long enough to show
 * a black canvas. Waiting for one real frame closes it.
 *
 * Bounded by a timeout so a source that never delivers still starts the app,
 * where the on-screen error handling can take over.
 */
async function waitForFirstFrame(video: HTMLVideoElement, timeoutMs = 4000): Promise<void> {
  let settled = false;
  const firstFrame = new Promise<void>((resolve) => {
    const done = () => {
      settled = true;
      resolve();
    };
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(done);
      return;
    }
    // Fallback for browsers without rVFC: poll readyState on animation frames.
    // `settled` stops the poll rescheduling forever when the timeout wins.
    const poll = () => {
      if (settled) return;
      if (video.readyState >= 3) done();
      else requestAnimationFrame(poll);
    };
    poll();
  });
  const timeout = new Promise<void>((resolve) =>
    setTimeout(() => {
      settled = true;
      resolve();
    }, timeoutMs)
  );
  await Promise.race([firstFrame, timeout]);
}

export async function startCamera(request: CameraRequest = {}): Promise<VideoSource> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new AppError(
      "unsupported-browser",
      "This browser does not expose getUserMedia. Use a current Chrome or Edge, served over http://localhost or https."
    );
  }

  const constraints: MediaStreamConstraints = {
    audio: false,
    video: {
      width: { ideal: request.width ?? 1280 },
      height: { ideal: request.height ?? 720 },
      frameRate: { ideal: 60, max: 60 },
      ...(request.deviceId ? { deviceId: { exact: request.deviceId } } : { facingMode: "user" }),
    },
  };

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new AppError(
        "permission-denied",
        "Webcam permission was denied. Allow camera access for this page and reload."
      );
    }
    if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") {
      throw new AppError("no-webcam", "No usable webcam was found on this computer.");
    }
    throw new AppError(
      "stream-failed",
      `The webcam could not be started (${name || "unknown error"}). It may be in use by another application.`
    );
  }

  const video = makeVideoElement();
  video.srcObject = stream;
  try {
    await waitForMetadata(video);
    await video.play();
    await waitForFirstFrame(video);
  } catch (err) {
    // The stream is live but unusable and nobody owns it yet: release it here or
    // the camera light stays on for the life of the tab.
    for (const t of stream.getTracks()) t.stop();
    video.srcObject = null;
    video.remove();
    throw err instanceof AppError
      ? err
      : new AppError("stream-failed", "The webcam stream could not be started.");
  }

  const track = stream.getVideoTracks()[0];
  return {
    video,
    label: track?.label || "Webcam",
    synthetic: false,
    stop() {
      for (const t of stream.getTracks()) t.stop();
      video.srcObject = null;
      video.remove();
    },
  };
}

/**
 * Animated test pattern wrapped in a real `<video>` element via
 * `canvas.captureStream()`, so every downstream stage (texture upload, crop,
 * mirroring, shader) behaves exactly as it does with a webcam. Used by the
 * `?synthetic=1` mode to verify alignment and the ASCII effect on machines
 * with no camera.
 */
export async function startSyntheticSource(width = 1280, height = 720): Promise<VideoSource> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new AppError("unsupported-browser", "2D canvas is unavailable.");

  let raf = 0;
  const start = performance.now();

  const draw = () => {
    const t = (performance.now() - start) / 1000;

    const bg = ctx.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, "#101820");
    bg.addColorStop(1, "#2a1830");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    // Reference grid: makes any crop or mirror error immediately visible.
    ctx.strokeStyle = "rgba(120,160,180,0.35)";
    ctx.lineWidth = 1;
    const step = width / 16;
    for (let x = 0; x <= width; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y <= height; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // Asymmetric marks so a horizontal flip cannot go unnoticed.
    ctx.fillStyle = "#ff6b3d";
    ctx.font = `${Math.round(height * 0.09)}px "Segoe UI", sans-serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText("LEFT", width * 0.03, height * 0.5);
    ctx.textAlign = "right";
    ctx.fillStyle = "#3dd6ff";
    ctx.fillText("RIGHT", width * 0.97, height * 0.5);
    ctx.textAlign = "center";
    ctx.fillStyle = "#eaeaea";
    ctx.fillText("TOP", width * 0.5, height * 0.09);

    // Moving luminance ramp gives the ASCII effect something to chew on.
    for (let i = 0; i < 6; i += 1) {
      const phase = t * 0.55 + i * 0.7;
      const cx = width * (0.5 + 0.34 * Math.cos(phase));
      const cy = height * (0.5 + 0.3 * Math.sin(phase * 1.3));
      const r = height * (0.09 + 0.05 * Math.sin(phase * 2.1));
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, "rgba(255,255,255,0.95)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }

    raf = requestAnimationFrame(draw);
  };
  draw();

  const stream = canvas.captureStream(60);
  const video = makeVideoElement();
  video.srcObject = stream;
  await waitForMetadata(video);
  await video.play();
  await waitForFirstFrame(video);

  return {
    video,
    label: "Synthetic test pattern",
    synthetic: true,
    stop() {
      cancelAnimationFrame(raf);
      for (const t of stream.getTracks()) t.stop();
      video.srcObject = null;
      video.remove();
    },
  };
}
