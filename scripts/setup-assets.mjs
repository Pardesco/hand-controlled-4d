/**
 * Copies the MediaPipe Tasks Vision WASM runtime out of node_modules into
 * `public/mediapipe/wasm`, and downloads the hand landmarker model into
 * `public/models` if it is not already present.
 *
 * Everything the app needs at runtime is therefore served from the local dev
 * server -- no CDN, no cloud call while the app is running.
 *
 * The model download is the ONE network access in this project and it happens
 * at install time only. If the machine is offline, drop
 * `hand_landmarker.task` into `public/models/` by hand and re-run.
 */
import { createWriteStream } from "node:fs";
import { access, copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const WASM_SRC = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const WASM_DEST = join(root, "public", "mediapipe", "wasm");

const MODEL_DEST = join(root, "public", "models", "hand_landmarker.task");
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

/** Minimum plausible size for the .task bundle, guards against a truncated download. */
const MODEL_MIN_BYTES = 1_000_000;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function copyWasmRuntime() {
  if (!(await exists(WASM_SRC))) {
    console.warn(
      "[setup-assets] @mediapipe/tasks-vision wasm folder not found. Run `npm install` first."
    );
    return;
  }
  await mkdir(WASM_DEST, { recursive: true });
  const files = await readdir(WASM_SRC);
  let copied = 0;
  for (const file of files) {
    const from = join(WASM_SRC, file);
    const to = join(WASM_DEST, file);
    const src = await stat(from);
    if (!src.isFile()) continue;
    if (await exists(to)) {
      const dst = await stat(to);
      if (dst.size === src.size) continue; // already current
    }
    await copyFile(from, to);
    copied += 1;
  }
  console.log(
    copied > 0
      ? `[setup-assets] copied ${copied} MediaPipe WASM file(s) to public/mediapipe/wasm`
      : "[setup-assets] MediaPipe WASM runtime already up to date"
  );
}

async function fetchModel() {
  if (await exists(MODEL_DEST)) {
    const info = await stat(MODEL_DEST);
    if (info.size >= MODEL_MIN_BYTES) {
      console.log("[setup-assets] hand_landmarker.task already present");
      return;
    }
    console.warn("[setup-assets] existing hand_landmarker.task looks truncated, re-downloading");
  }
  await mkdir(dirname(MODEL_DEST), { recursive: true });
  console.log("[setup-assets] downloading hand_landmarker.task ...");
  try {
    const res = await fetch(MODEL_URL);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(MODEL_DEST));
    const info = await stat(MODEL_DEST);
    if (info.size < MODEL_MIN_BYTES) throw new Error(`downloaded file is only ${info.size} bytes`);
    console.log(`[setup-assets] model saved (${(info.size / 1e6).toFixed(1)} MB)`);
  } catch (err) {
    console.warn(
      `[setup-assets] could not download the hand model (${err.message}).\n` +
        `  Download it manually from:\n    ${MODEL_URL}\n` +
        `  and save it as:\n    public/models/hand_landmarker.task\n` +
        "  The app will still start; hand tracking will report a model load error."
    );
  }
}

await copyWasmRuntime();
await fetchModel();
