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

  worker = new Worker("./edgecrunch-worker.js?v=041");

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
      const targetMaskCanvas = message.maskPixels
        ? pixelsToCanvas(
            message.width,
            message.height,
            message.maskPixels
          )
        : null;

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


function createIsolatedWorkerSession() {
  const isolated = new Worker("./edgecrunch-worker.js?v=041");
  let readyResolve;
  let readyReject;
  let pending = null;
  let localId = 0;

  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const timeout = setTimeout(() => {
    readyReject(
      new Error("Full-resolution EdgeCrunch worker did not start within 5 seconds.")
    );
  }, 5000);

  isolated.addEventListener("message", (event) => {
    const message = event.data || {};

    if (message.type === "worker-ready") {
      clearTimeout(timeout);
      readyResolve();
      return;
    }

    if (!pending || message.id !== pending.id) return;

    if (message.type === "progress") {
      pending.onProgress?.(message.message);
      return;
    }

    if (message.type === "result") {
      const resolve = pending.resolve;
      pending = null;
      resolve(message);
      return;
    }

    if (message.type === "error") {
      const reject = pending.reject;
      pending = null;
      reject(
        new Error(message.message || "Full-resolution EdgeCrunch worker failed.")
      );
    }
  });

  isolated.addEventListener("error", (event) => {
    clearTimeout(timeout);
    const error = new Error(
      event.message || "Full-resolution EdgeCrunch worker stopped unexpectedly."
    );
    readyReject(error);
    pending?.reject(error);
    pending = null;
  });

  return {
    ready,
    async process(width, height, pixels, settings, onProgress) {
      await ready;
      const id = ++localId;

      return new Promise((resolve, reject) => {
        pending = { id, resolve, reject, onProgress };

        isolated.postMessage(
          {
            type: "process",
            id,
            width,
            height,
            settings,
            pixels: pixels.buffer,
            includeMask: false,
          },
          [pixels.buffer]
        );
      });
    },
    terminate() {
      isolated.terminate();
    },
  };
}

const nextFrame = () =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

export async function processFullResolutionTiled(
  imageBitmap,
  settings,
  onProgress = () => {},
  {
    tileSize = 768,
    overlap = 24,
  } = {}
) {
  const width = imageBitmap.width;
  const height = imageBitmap.height;

  const output = document.createElement("canvas");
  output.width = width;
  output.height = height;
  const outputCtx = output.getContext("2d");

  const tileCanvas = document.createElement("canvas");
  const tileCtx = tileCanvas.getContext("2d", {
    willReadFrequently: true,
  });

  const resultCanvas = document.createElement("canvas");
  const resultCtx = resultCanvas.getContext("2d");

  const cols = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);
  const total = cols * rows;
  let completed = 0;

  const session = createIsolatedWorkerSession();

  try {
    onProgress(
      `Preparing full-resolution export: ${width}×${height} · ${total} tiles`
    );

    await session.ready;

    for (let tileY = 0; tileY < rows; tileY++) {
      for (let tileX = 0; tileX < cols; tileX++) {
        const coreX = tileX * tileSize;
        const coreY = tileY * tileSize;
        const coreW = Math.min(tileSize, width - coreX);
        const coreH = Math.min(tileSize, height - coreY);

        const sx = Math.max(0, coreX - overlap);
        const sy = Math.max(0, coreY - overlap);
        const ex = Math.min(width, coreX + coreW + overlap);
        const ey = Math.min(height, coreY + coreH + overlap);
        const sw = ex - sx;
        const sh = ey - sy;

        tileCanvas.width = sw;
        tileCanvas.height = sh;
        tileCtx.clearRect(0, 0, sw, sh);
        tileCtx.drawImage(
          imageBitmap,
          sx,
          sy,
          sw,
          sh,
          0,
          0,
          sw,
          sh
        );

        const imageData = tileCtx.getImageData(0, 0, sw, sh);
        const tileNumber = completed + 1;

        const result = await session.process(
          sw,
          sh,
          imageData.data,
          settings,
          (message) => {
            onProgress(
              `Full-resolution cleanup ${tileNumber}/${total}: ${message}`
            );
          }
        );

        resultCanvas.width = sw;
        resultCanvas.height = sh;
        resultCtx.putImageData(
          new ImageData(
            new Uint8ClampedArray(result.outputPixels),
            sw,
            sh
          ),
          0,
          0
        );

        const cropX = coreX - sx;
        const cropY = coreY - sy;

        outputCtx.drawImage(
          resultCanvas,
          cropX,
          cropY,
          coreW,
          coreH,
          coreX,
          coreY,
          coreW,
          coreH
        );

        completed += 1;
        onProgress(
          `Full-resolution cleanup: ${completed}/${total} tiles complete`
        );

        await nextFrame();
      }
    }

    return output;
  } finally {
    session.terminate();
  }
}
