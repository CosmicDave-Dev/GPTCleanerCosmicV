// CosmicV EdgeCrunch Darkroom Web
// Browser-side port of the V1.4 EdgeCrunch cleanup detector.
// OpenCV.js supplies color conversion/convolution/morphology. Images remain local.

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

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

const yieldToBrowser = () =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

async function forChunks(length, callback, chunkSize = 131072) {
  for (let start = 0; start < length; start += chunkSize) {
    const end = Math.min(length, start + chunkSize);
    callback(start, end);
    await yieldToBrowser();
  }
}

export async function waitForOpenCV(timeoutMs = 30000) {
  const started = performance.now();

  while (performance.now() - started < timeoutMs) {
    let candidate = window.cv;

    if (candidate && typeof candidate.then === "function") {
      try {
        candidate = await candidate;
        window.cv = candidate;
      } catch {
        candidate = null;
      }
    }

    if (candidate?.Mat && candidate?.cvtColor && candidate?.Sobel) {
      return candidate;
    }

    await new Promise((resolve) => setTimeout(resolve, 75));
  }

  throw new Error("OpenCV.js did not finish loading.");
}

function percentile(values, percent) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = clamp(
    Math.round((percent / 100) * (sorted.length - 1)),
    0,
    sorted.length - 1
  );
  return sorted[index];
}

async function robustUnit(cv, mat, lo, hi) {
  const input = mat.data32F;
  const maxSamples = 50000;
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

  await forChunks(input.length, (start, end) => {
    for (let i = start; i < end; i++) {
      dst[i] = clamp((input[i] - low) / span, 0, 1);
    }
  });

  return out;
}

async function absFloatMat(cv, mat) {
  const out = new cv.Mat(mat.rows, mat.cols, cv.CV_32F);
  const src = mat.data32F;
  const dst = out.data32F;

  await forChunks(src.length, (start, end) => {
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

function imageBitmapToMat(cv, bitmap) {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return cv.matFromImageData(
    ctx.getImageData(0, 0, canvas.width, canvas.height)
  );
}

function rgbMatToCanvas(mat) {
  const canvas = document.createElement("canvas");
  canvas.width = mat.cols;
  canvas.height = mat.rows;
  const ctx = canvas.getContext("2d");
  const rgba = new Uint8ClampedArray(mat.rows * mat.cols * 4);
  const rgb = mat.data;

  for (let src = 0, dst = 0; src < rgb.length; src += 3, dst += 4) {
    rgba[dst] = rgb[src];
    rgba[dst + 1] = rgb[src + 1];
    rgba[dst + 2] = rgb[src + 2];
    rgba[dst + 3] = 255;
  }

  ctx.putImageData(new ImageData(rgba, mat.cols, mat.rows), 0, 0);
  return canvas;
}

function maskOverlayCanvas(rgbMat, maskMat) {
  const canvas = document.createElement("canvas");
  canvas.width = rgbMat.cols;
  canvas.height = rgbMat.rows;
  const ctx = canvas.getContext("2d");
  const rgba = new Uint8ClampedArray(rgbMat.rows * rgbMat.cols * 4);
  const rgb = rgbMat.data;
  const mask = maskMat.data32F;

  for (let p = 0, src = 0, dst = 0; p < mask.length; p++, src += 3, dst += 4) {
    const m = clamp(mask[p], 0, 1);
    rgba[dst] = clamp(rgb[src] * 0.50 + 255 * m * 0.50, 0, 255);
    rgba[dst + 1] = clamp(rgb[src + 1] * 0.50, 0, 255);
    rgba[dst + 2] = clamp(rgb[src + 2] * 0.50 + 120 * m * 0.50, 0, 255);
    rgba[dst + 3] = 255;
  }

  ctx.putImageData(new ImageData(rgba, rgbMat.cols, rgbMat.rows), 0, 0);
  return canvas;
}

export async function processImage(imageBitmap, settings, onProgress = () => {}) {
  const cv = await waitForOpenCV();

  const cfg = {
    edgeCrunch: clamp(settings.edgeCrunch ?? 0.55, 0, 1),
    fragmentSensitivity: clamp(settings.fragmentSensitivity ?? 0.65, 0, 1),
    structureProtection: clamp(settings.structureProtection ?? 0.90, 0, 1),
    crunchRadius: clamp(settings.crunchRadius ?? 0.80, 0.35, 2.50),
    baseCleanup: clamp(settings.baseCleanup ?? 0.15, 0, 1),
    speckThreshold: Math.max(1, Math.round(settings.speckThreshold ?? 10)),
  };

  const owned = [];
  const keep = (mat) => {
    owned.push(mat);
    return mat;
  };

  try {
    onProgress("Preparing image...");

    const rgba = keep(imageBitmapToMat(cv, imageBitmap));
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

    onProgress("Finding fragmented edges...");

    const gx = keep(new cv.Mat());
    const gy = keep(new cv.Mat());
    cv.Sobel(lf, gx, cv.CV_32F, 1, 0, 3);
    cv.Sobel(lf, gy, cv.CV_32F, 0, 1, 3);

    const magnitude = keep(new cv.Mat());
    cv.magnitude(gx, gy, magnitude);
    const grad = keep(await robustUnit(cv, magnitude, 5.0, 99.5));

    const lap = keep(new cv.Mat());
    cv.Laplacian(lf, lap, cv.CV_32F, 3);
    const absLap = keep(await absFloatMat(cv, lap));
    const highFreq = keep(await robustUnit(cv, absLap, 10.0, 97.0));

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
    cv.GaussianBlur(gx2, jxx, tensorKernel, 1.5, 1.5, cv.BORDER_DEFAULT);
    cv.GaussianBlur(gy2, jyy, tensorKernel, 1.5, 1.5, cv.BORDER_DEFAULT);
    cv.GaussianBlur(gxgy, jxy, tensorKernel, 1.5, 1.5, cv.BORDER_DEFAULT);

    const coherence = keep(new cv.Mat(lf.rows, lf.cols, cv.CV_32F));
    const mediumEdge = keep(new cv.Mat(lf.rows, lf.cols, cv.CV_32F));
    const microEdge = keep(new cv.Mat(lf.rows, lf.cols, cv.CV_32F));
    const seeds = keep(new cv.Mat(lf.rows, lf.cols, cv.CV_32F));

    const gArr = grad.data32F;
    const hArr = highFreq.data32F;
    const xx = jxx.data32F;
    const yy = jyy.data32F;
    const xy = jxy.data32F;
    const cohArr = coherence.data32F;
    const medArr = mediumEdge.data32F;
    const microArr = microEdge.data32F;
    const seedArr = seeds.data32F;

    const threshold = 0.52 - 0.28 * cfg.fragmentSensitivity;

    await forChunks(gArr.length, (start, end) => {
      for (let i = start; i < end; i++) {
        const dx = xx[i] - yy[i];
        const numerator = Math.sqrt(dx * dx + 4 * xy[i] * xy[i]);
        cohArr[i] = numerator / (xx[i] + yy[i] + 1e-6);

        const medium =
          smoothstepScalar(gArr[i], 0.06, 0.38) *
          (1 - smoothstepScalar(gArr[i], 0.70, 0.97));

        const micro =
          smoothstepScalar(hArr[i], 0.06, 0.50) *
          (1 - 0.20 * smoothstepScalar(hArr[i], 0.85, 1.0));

        medArr[i] = medium;
        microArr[i] = micro;
        seedArr[i] = micro > threshold && medium > 0.12 ? 1 : 0;
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

    const mask = keep(new cv.Mat(lf.rows, lf.cols, cv.CV_32F));
    const density = densityRaw.data32F;
    const maskArr = mask.data32F;
    const incoherentPower = 0.55 + 1.65 * (1 - cfg.fragmentSensitivity);

    await forChunks(maskArr.length, (start, end) => {
      for (let i = start; i < end; i++) {
        const densityScore = smoothstepScalar(density[i], 0.04, 0.42);
        const incoherent = Math.pow(
          clamp(1 - cohArr[i], 0, 1),
          incoherentPower
        );

        let value =
          (0.64 * microArr[i] * medArr[i] +
            0.36 * densityScore * medArr[i]) *
          (0.40 + 0.60 * incoherent);

        value *= clamp(
          1 - cfg.structureProtection * 0.60 * cohArr[i],
          0,
          1
        );

        value *= 1 - smoothstepScalar(gArr[i], 0.78, 0.98);

        const flatTexture =
          hArr[i] *
          Math.pow(
            1 - smoothstepScalar(gArr[i], 0.35, 0.75),
            1.4
          );

        maskArr[i] = Math.max(value, cfg.baseCleanup * flatTexture);
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

    onProgress("Reconstructing targeted texture...");

    const candidate = keep(new cv.Mat());
    const candidateKernel = gaussianKernelForSigma(cfg.crunchRadius);
    cv.GaussianBlur(
      lf,
      candidate,
      new cv.Size(candidateKernel, candidateKernel),
      cfg.crunchRadius,
      cfg.crunchRadius,
      cv.BORDER_DEFAULT
    );

    const cleaned = keep(new cv.Mat(lf.rows, lf.cols, cv.CV_32F));
    const lfArr = lf.data32F;
    const candArr = candidate.data32F;
    const smArr = maskSmooth.data32F;
    const cleanArr = cleaned.data32F;

    await forChunks(cleanArr.length, (start, end) => {
      for (let i = start; i < end; i++) {
        const amount = clamp(cfg.edgeCrunch * smArr[i] * 1.60, 0, 0.92);
        cleanArr[i] = lfArr[i] * (1 - amount) + candArr[i] * amount;
      }
    });

    onProgress("Cleaning specks...");

    const kernel = keep(
      cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3))
    );
    const opened = keep(new cv.Mat());
    const closed = keep(new cv.Mat());
    cv.morphologyEx(lum, opened, cv.MORPH_OPEN, kernel);
    cv.morphologyEx(lum, closed, cv.MORPH_CLOSE, kernel);

    const lum8 = lum.data;
    const open8 = opened.data;
    const close8 = closed.data;
    const speckEnd = Math.max(
      cfg.speckThreshold + 8,
      cfg.speckThreshold * 2
    );

    await forChunks(cleanArr.length, (start, end) => {
      for (let i = start; i < end; i++) {
        const bright = Math.max(lum8[i] - open8[i], 0);
        const dark = Math.max(close8[i] - lum8[i], 0);
        const hat = Math.max(bright, dark);
        let hatMask = smoothstepScalar(
          hat,
          cfg.speckThreshold,
          speckEnd
        );
        hatMask *= smArr[i] * cfg.edgeCrunch * 0.22;
        const morphTarget = dark > bright ? close8[i] : open8[i];
        cleanArr[i] =
          cleanArr[i] * (1 - hatMask) + morphTarget * hatMask;
        cleanArr[i] = clamp(cleanArr[i], 0, 255);
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

    onProgress("Rendering result...");

    return {
      outputCanvas: rgbMatToCanvas(outRgb),
      targetMaskCanvas: maskOverlayCanvas(outRgb, maskSmooth),
    };
  } finally {
    for (let i = owned.length - 1; i >= 0; i--) {
      try {
        owned[i]?.delete?.();
      } catch {
        // Best-effort cleanup for OpenCV WASM memory.
      }
    }
  }
}
