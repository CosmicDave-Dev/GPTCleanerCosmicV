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
let nextRequestId = 0;
const requests = new Map();

function getWorker() {
  if (worker) return worker;

  worker = new Worker("./edgecrunch-worker.js");

  worker.addEventListener("message", (event) => {
    const message = event.data || {};
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
    const error = new Error(
      event.message || "EdgeCrunch worker stopped unexpectedly."
    );

    for (const request of requests.values()) {
      request.reject(error);
    }

    requests.clear();
    worker?.terminate();
    worker = null;
  });

  return worker;
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
  const currentWorker = getWorker();
  const id = ++nextRequestId;

  for (const [requestId, request] of requests.entries()) {
    if (requestId < id) {
      const error = new Error("Superseded by newer EdgeCrunch settings.");
      error.name = "AbortError";
      request.reject(error);
      requests.delete(requestId);
    }
  }

  onProgress("Sending image to background EdgeCrunch worker...");

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
