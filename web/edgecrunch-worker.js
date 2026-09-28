// CosmicV EdgeCrunch Darkroom Web Worker
// Heavy OpenCV.js work lives here so Firefox's UI thread stays responsive.

const OPENCV_URL = "https://docs.opencv.org/4.x/opencv.js";

let cvPromise = null;
let pendingRequest = null;
let pumping = false;

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

class CancelledError extends Error {
  constructor() {
    super("Superseded by newer settings.");
    this.name = "CancelledError";
  }
}

function postProgress(id, message) {
  self.postMessage({ type: "progress", id, message });
}

function isStale(id) {
  return pendingRequest && pendingRequest.id > id;
}

async function yieldWorker(id) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (isStale(id)) throw new CancelledError();
}

async function forChunks(id, length, callback, chunkSize = 65536) {
  for (let start = 0; start < length; start += chunkSize) {
    const end = Math.min(length, start + chunkSize);
    callback(start, end);
    await yieldWorker(id);
  }
}

async function ensureOpenCV(id) {
  if (!cvPromise) {
    cvPromise = (async () => {
      postProgress(id, "Loading EdgeCrunch engine in background...");
      importScripts(OPENCV_URL);

      let candidate =
        self.cv ||
        (typeof cv !== "undefined" ? cv : null);

      if (candidate && typeof candidate.then === "function") {
        candidate = await candidate;
      }

      const started = Date.now();
      while (
        (!candidate?.Mat ||
          !candidate?.cvtColor ||
          !candidate?.Sobel) &&
        Date.now() - started < 30000
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        candidate =
          self.cv ||
          (typeof cv !== "undefined" ? cv : null);

        if (candidate && typeof candidate.then === "function") {
          candidate = await candidate;
        }
      }

      if (!candidate?.Mat) {
        throw new Error("OpenCV.js did not initialize in the worker.");
      }

      self.cv = candidate;
      return candidate;
    })().catch((error) => {
      cvPromise = null;
      throw error;
    });
  }

  return cvPromise;
}

function percentile(values, percent) {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);

  const index = clamp(
    Math.round((percent / 100) * (values.length - 1)),
    0,
    values.length - 1
  );

  return values[index];
}

async function robustUnit(id, cv, mat, lo, hi) {
  const input = mat.data32F;
  const maxSamples = 20000;
  const step = Math.max(1, Math.floor(input.length / maxSamples));
  const sample = [];

  for (let i = 0; i < input.length; i += step) {
    const value = input[i];
    if (Number.isFinite(value)) sample.push(value);
  }

  const low = percentile(sample, lo);
  const high = percentile(sample, hi);
  const span = Math.max(1e-6, high - low);

  const out = new cv.Mat(mat.rows, mat.cols, cv.CV_32F);
  const dst = out.data32F;

  await forChunks(id, input.length, (start, end) => {
    for (let i = start; i < end; i++) {
      dst[i] = clamp((input[i] - low) / span, 0, 1);
    }
  });

  return out;
}

async function absFloatMat(id, cv, mat) {
  const out = new cv.Mat(mat.rows, mat.cols, cv.CV_32F);
  const src = mat.data32F;
  const dst = out.data32F;

  await forChunks(id, src.length, (start, end) => {
    for (let i = start; i < end; i++) {
      dst[i] = Math.abs(src[i]);
    }
  });

  return out;
}

function smoothstepScalar(x, a, b) {
  const t = clamp((x - a) / Math.max(1e-6, b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function gaussianKernelForSigma(sigma) {
  const radius = Math.max(1, Math.ceil(Math.max(0.1, sigma) * 3));
  return radius * 2 + 1;
}

async function processRequest(request) {
  const id = request.id;
  const cv = await ensureOpenCV(id);

  if (isStale(id)) throw new CancelledError();

  const settings = request.settings || {};
  const cfg = {
    edgeCrunch: clamp(settings.edgeCrunch ?? 0.55, 0, 1),
    fragmentSensitivity: clamp(
      settings.fragmentSensitivity ?? 0.65,
      0,
      1
    ),
    structureProtection: clamp(
      settings.structureProtection ?? 0.90,
      0,
      1
    ),
    crunchRadius: clamp(settings.crunchRadius ?? 0.80, 0.35, 2.50),
    baseCleanup: clamp(settings.baseCleanup ?? 0.15, 0, 1),
    speckThreshold: Math.max(
      1,
      Math.round(settings.speckThreshold ?? 10)
    ),
  };

  const owned = [];
  const keep = (mat) => {
    owned.push(mat);
    return mat;
  };

  try {
    postProgress(id, "Preparing browser preview...");

    const rgba = keep(
      new cv.Mat(
        request.height,
        request.width,
        cv.CV_8UC4
      )
    );
    rgba.data.set(new Uint8Array(request.pixels));

    const rgb = keep(new cv.Mat());
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);

    const lab = keep(new cv.Mat());
    cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);

    const channels = new cv.MatVector();
    cv.split(lab, channels);

    const lum = keep(channels.get(0));
    const channelA = keep(channels.get(1));
    const channelB = keep(channels.get(2));
    channels.delete();

    const lf = keep(new cv.Mat());
    lum.convertTo(lf, cv.CV_32F);

    postProgress(id, "Finding fragmented micro-edges...");

    const gx = keep(new cv.Mat());
    const gy = keep(new cv.Mat());
    cv.Sobel(lf, gx, cv.CV_32F, 1, 0, 3);
    cv.Sobel(lf, gy, cv.CV_32F, 0, 1, 3);

    const magnitude = keep(new cv.Mat());
    cv.magnitude(gx, gy, magnitude);
    const grad = keep(
      await robustUnit(id, cv, magnitude, 5.0, 99.5)
    );

    const lap = keep(new cv.Mat());
    cv.Laplacian(lf, lap, cv.CV_32F, 3);
    const absLap = keep(await absFloatMat(id, cv, lap));
    const highFreq = keep(
      await robustUnit(id, cv, absLap, 10.0, 97.0)
    );

    const gx2 = keep(new cv.Mat());
    const gy2 = keep(new cv.Mat());
    const gxgy = keep(new cv.Mat());

    cv.multiply(gx, gx, gx2);
    cv.multiply(gy, gy, gy2);
    cv.multiply(gx, gy, gxgy);

    const jxx = keep(new cv.Mat());
    const jyy = keep(new cv.Mat());
    const jxy = keep(new cv.Mat());

    const tensorKernel = new cv.Size(11, 11);

    cv.GaussianBlur(
      gx2,
      jxx,
      tensorKernel,
      1.5,
      1.5,
      cv.BORDER_DEFAULT
    );
    cv.GaussianBlur(
      gy2,
      jyy,
      tensorKernel,
      1.5,
      1.5,
      cv.BORDER_DEFAULT
    );
    cv.GaussianBlur(
      gxgy,
      jxy,
      tensorKernel,
      1.5,
      1.5,
      cv.BORDER_DEFAULT
    );

    await yieldWorker(id);

    const coherence = keep(
      new cv.Mat(lf.rows, lf.cols, cv.CV_32F)
    );
    const mediumEdge = keep(
      new cv.Mat(lf.rows, lf.cols, cv.CV_32F)
    );
    const microEdge = keep(
      new cv.Mat(lf.rows, lf.cols, cv.CV_32F)
    );
    const seeds = keep(
      new cv.Mat(lf.rows, lf.cols, cv.CV_32F)
    );

    const gArr = grad.data32F;
    const hArr = highFreq.data32F;
    const xx = jxx.data32F;
    const yy = jyy.data32F;
    const xy = jxy.data32F;
    const cohArr = coherence.data32F;
    const medArr = mediumEdge.data32F;
    const microArr = microEdge.data32F;
    const seedArr = seeds.data32F;

    const threshold =
      0.52 - 0.28 * cfg.fragmentSensitivity;

    await forChunks(id, gArr.length, (start, end) => {
      for (let i = start; i < end; i++) {
        const dx = xx[i] - yy[i];
        const numerator = Math.sqrt(
          dx * dx + 4 * xy[i] * xy[i]
        );

        cohArr[i] =
          numerator / (xx[i] + yy[i] + 1e-6);

        const medium =
          smoothstepScalar(gArr[i], 0.06, 0.38) *
          (1 - smoothstepScalar(gArr[i], 0.70, 0.97));

        const micro =
          smoothstepScalar(hArr[i], 0.06, 0.50) *
          (1 -
            0.20 *
              smoothstepScalar(hArr[i], 0.85, 1.0));

        medArr[i] = medium;
        microArr[i] = micro;
        seedArr[i] =
          micro > threshold && medium > 0.12 ? 1 : 0;
      }
    });

    const densityRaw = keep(new cv.Mat());

    cv.blur(
      seeds,
      densityRaw,
      new cv.Size(7, 7),
      new cv.Point(-1, -1),
      cv.BORDER_DEFAULT
    );

    const mask = keep(
      new cv.Mat(lf.rows, lf.cols, cv.CV_32F)
    );

    const density = densityRaw.data32F;
    const maskArr = mask.data32F;

    const incoherentPower =
      0.55 +
      1.65 * (1 - cfg.fragmentSensitivity);

    await forChunks(id, maskArr.length, (start, end) => {
      for (let i = start; i < end; i++) {
        const densityScore = smoothstepScalar(
          density[i],
          0.04,
          0.42
        );

        const incoherent = Math.pow(
          clamp(1 - cohArr[i], 0, 1),
          incoherentPower
        );

        let value =
          (0.64 * microArr[i] * medArr[i] +
            0.36 * densityScore * medArr[i]) *
          (0.40 + 0.60 * incoherent);

        value *= clamp(
          1 -
            cfg.structureProtection *
              0.60 *
              cohArr[i],
          0,
          1
        );

        value *=
          1 -
          smoothstepScalar(gArr[i], 0.78, 0.98);

        const flatTexture =
          hArr[i] *
          Math.pow(
            1 -
              smoothstepScalar(
                gArr[i],
                0.35,
                0.75
              ),
            1.4
          );

        maskArr[i] = Math.max(
          value,
          cfg.baseCleanup * flatTexture
        );
      }
    });

    const maskSmooth = keep(new cv.Mat());

    cv.GaussianBlur(
      mask,
      maskSmooth,
      new cv.Size(5, 5),
      0.50,
      0.50,
      cv.BORDER_DEFAULT
    );

    postProgress(id, "Reconstructing targeted texture...");

    const candidate = keep(new cv.Mat());
    const candidateKernel = gaussianKernelForSigma(
      cfg.crunchRadius
    );

    cv.GaussianBlur(
      lf,
      candidate,
      new cv.Size(candidateKernel, candidateKernel),
      cfg.crunchRadius,
      cfg.crunchRadius,
      cv.BORDER_DEFAULT
    );

    const cleaned = keep(
      new cv.Mat(lf.rows, lf.cols, cv.CV_32F)
    );

    const lfArr = lf.data32F;
    const candArr = candidate.data32F;
    const smArr = maskSmooth.data32F;
    const cleanArr = cleaned.data32F;

    await forChunks(id, cleanArr.length, (start, end) => {
      for (let i = start; i < end; i++) {
        const amount = clamp(
          cfg.edgeCrunch * smArr[i] * 1.60,
          0,
          0.92
        );

        cleanArr[i] =
          lfArr[i] * (1 - amount) +
          candArr[i] * amount;
      }
    });

    postProgress(id, "Cleaning specks...");

    const kernel = keep(
      cv.getStructuringElement(
        cv.MORPH_ELLIPSE,
        new cv.Size(3, 3)
      )
    );

    const opened = keep(new cv.Mat());
    const closed = keep(new cv.Mat());

    cv.morphologyEx(
      lum,
      opened,
      cv.MORPH_OPEN,
      kernel
    );

    cv.morphologyEx(
      lum,
      closed,
      cv.MORPH_CLOSE,
      kernel
    );

    const lum8 = lum.data;
    const open8 = opened.data;
    const close8 = closed.data;

    const speckEnd = Math.max(
      cfg.speckThreshold + 8,
      cfg.speckThreshold * 2
    );

    await forChunks(id, cleanArr.length, (start, end) => {
      for (let i = start; i < end; i++) {
        const bright = Math.max(
          lum8[i] - open8[i],
          0
        );

        const dark = Math.max(
          close8[i] - lum8[i],
          0
        );

        const hat = Math.max(bright, dark);

        let hatMask = smoothstepScalar(
          hat,
          cfg.speckThreshold,
          speckEnd
        );

        hatMask *=
          smArr[i] *
          cfg.edgeCrunch *
          0.22;

        const morphTarget =
          dark > bright ? close8[i] : open8[i];

        cleanArr[i] =
          cleanArr[i] * (1 - hatMask) +
          morphTarget * hatMask;

        cleanArr[i] = clamp(
          cleanArr[i],
          0,
          255
        );
      }
    });

    const cleanedLum = keep(new cv.Mat());
    cleaned.convertTo(cleanedLum, cv.CV_8U);

    const mergedChannels = new cv.MatVector();
    mergedChannels.push_back(cleanedLum);
    mergedChannels.push_back(channelA);
    mergedChannels.push_back(channelB);

    const outLab = keep(new cv.Mat());
    cv.merge(mergedChannels, outLab);
    mergedChannels.delete();

    const outRgb = keep(new cv.Mat());
    cv.cvtColor(outLab, outRgb, cv.COLOR_Lab2RGB);

    const outRgba = keep(new cv.Mat());
    cv.cvtColor(outRgb, outRgba, cv.COLOR_RGB2RGBA);

    postProgress(id, "Rendering background result...");

    const outputPixels = new Uint8ClampedArray(
      outRgba.data.length
    );
    outputPixels.set(outRgba.data);

    const maskPixels = new Uint8ClampedArray(
      request.width *
        request.height *
        4
    );

    const outRgbData = outRgb.data;
    const smoothMask = maskSmooth.data32F;

    await forChunks(
      id,
      smoothMask.length,
      (start, end) => {
        for (let p = start; p < end; p++) {
          const src = p * 3;
          const dst = p * 4;
          const m = clamp(
            smoothMask[p],
            0,
            1
          );

          maskPixels[dst] = clamp(
            outRgbData[src] * 0.50 +
              255 * m * 0.50,
            0,
            255
          );

          maskPixels[dst + 1] = clamp(
            outRgbData[src + 1] * 0.50,
            0,
            255
          );

          maskPixels[dst + 2] = clamp(
            outRgbData[src + 2] * 0.50 +
              120 * m * 0.50,
            0,
            255
          );

          maskPixels[dst + 3] = 255;
        }
      }
    );

    if (isStale(id)) throw new CancelledError();

    self.postMessage(
      {
        type: "result",
        id,
        width: request.width,
        height: request.height,
        outputPixels: outputPixels.buffer,
        maskPixels: maskPixels.buffer,
      },
      [
        outputPixels.buffer,
        maskPixels.buffer,
      ]
    );
  } finally {
    for (let i = owned.length - 1; i >= 0; i--) {
      try {
        owned[i]?.delete?.();
      } catch {
        // Best effort WASM cleanup.
      }
    }
  }
}

async function pump() {
  if (pumping) return;
  pumping = true;

  try {
    while (pendingRequest) {
      const request = pendingRequest;
      pendingRequest = null;

      try {
        await processRequest(request);
      } catch (error) {
        if (error?.name === "CancelledError") {
          continue;
        }

        self.postMessage({
          type: "error",
          id: request.id,
          message:
            error?.message ||
            String(error),
        });
      }
    }
  } finally {
    pumping = false;

    if (pendingRequest) {
      pump();
    }
  }
}

self.addEventListener("message", (event) => {
  const message = event.data || {};

  if (message.type !== "process") return;

  pendingRequest = message;
  pump();
});
