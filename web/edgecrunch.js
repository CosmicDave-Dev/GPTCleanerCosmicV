// CosmicV EdgeCrunch Darkroom Web
// Main-thread client for the background EdgeCrunch Web Worker.

export const PRESETS = {
  Conservative: {
    edgeCrunch: 0.25,
    fragmentSensitivity: 0.45,
    structureProtection: 0.95,
    crunchRadius: 0.65,
    baseCleanup: 0.08,
    speckThreshold: 8,
  },
  Balanced: {
    edgeCrunch: 0.55,
    fragmentSensitivity: 0.65,
    structureProtection: 0.90,
    crunchRadius: 0.80,
    baseCleanup: 0.15,
    speckThreshold: 10,
  },
  Strong: {
    edgeCrunch: 0.75,
    fragmentSensitivity: 0.64,
    structureProtection: 0.68,
    crunchRadius: 1.05,
    baseCleanup: 0.52,
    speckThreshold: 14,
  },
  Aggressive: {
    edgeCrunch: 1.00,
    fragmentSensitivity: 0.53,
    structureProtection: 0.38,
    crunchRadius: 1.23,
    baseCleanup: 0.91,
    speckThreshold: 19,
  },
};

let worker = null;
let workerReadyPromise = null;
let nextRequestId = 0;
const requests = new Map();

function getWorker() {
  if (worker && workerReadyPromise) {
    return { worker, ready: workerReadyPromise };
  }

  let resolveReady;
  let rejectReady;

  workerReadyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  worker = new Worker("./edgecrunch-worker.js?v=031");

  const readyTimeout = setTimeout(() => {
    rejectReady(
      new Error("EdgeCrunch worker did not start within 5 seconds.")
    );
  }, 5000);

  worker.addEventListener("message", (event) => {
    const message = event.data || {};

    if (message.type === "worker-ready") {
      clearTimeout(readyTimeout);
      resolveReady();
      return;
    }

    const request = requests.get(message.id);
    if (!request) return;

    if (message.type === "progress") {
      request.onProgress?.(message.message);
      return;
    }

    if (message.type === "result") {
      requests.delete(message.id);

      const outputCanvas = pixelsToCanvas(
        message.width,
        message.height,
        message.outputPixels
      );
      const targetMaskCanvas = pixelsToCanvas(
        message.width,
        message.height,
        message.maskPixels
      );

      request.resolve({ outputCanvas, targetMaskCanvas });
      return;
    }

    if (message.type === "error") {
      requests.delete(message.id);
      request.reject(new Error(message.message || "EdgeCrunch worker failed."));
    }
  });

  worker.addEventListener("error", (event) => {
    clearTimeout(readyTimeout);

    const error = new Error(
      event.message || "EdgeCrunch worker stopped unexpectedly."
    );

    rejectReady(error);

    for (const request of requests.values()) {
      request.reject(error);
    }

    requests.clear();
    worker?.terminate();
    worker = null;
    workerReadyPromise = null;
  });

  return { worker, ready: workerReadyPromise };
}

function pixelsToCanvas(width, height, pixelsBuffer) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const pixels = new Uint8ClampedArray(pixelsBuffer);
  const imageData = new ImageData(pixels, width, height);
  canvas.getContext("2d").putImageData(imageData, 0, 0);

  return canvas;
}

function bitmapToPixels(bitmap) {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;

  const context = canvas.getContext("2d", {
    willReadFrequently: true,
  });
  context.drawImage(bitmap, 0, 0);

  const imageData = context.getImageData(
    0,
    0,
    canvas.width,
    canvas.height
  );

  return {
    width: canvas.width,
    height: canvas.height,
    pixels: imageData.data,
  };
}

export async function processImage(
  imageBitmap,
  settings,
  onProgress = () => {}
) {
  const { worker: currentWorker, ready } = getWorker();
  const id = ++nextRequestId;

  onProgress("Starting background EdgeCrunch worker...");
  await ready;

  for (const [requestId, request] of requests.entries()) {
    if (requestId < id) {
      const error = new Error("Superseded by newer EdgeCrunch settings.");
      error.name = "AbortError";
      request.reject(error);
      requests.delete(requestId);
    }
  }

  onProgress("Background worker ready. Sending image...");

  const { width, height, pixels } = bitmapToPixels(imageBitmap);

  return new Promise((resolve, reject) => {
    requests.set(id, { resolve, reject, onProgress });

    currentWorker.postMessage(
      {
        type: "process",
        id,
        width,
        height,
        settings,
        pixels: pixels.buffer,
      },
      [pixels.buffer]
    );
  });
}
