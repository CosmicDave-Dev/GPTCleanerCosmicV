// CosmicV EdgeCrunch Darkroom Web Worker
// Pure JavaScript / typed-array EdgeCrunch implementation.
// No OpenCV.js, no external runtime, no network dependency.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

let pendingRequest = null;
let pumping = false;

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

async function forRows(id, height, callback, rowsPerChunk = 24) {
  for (let y0 = 0; y0 < height; y0 += rowsPerChunk) {
    const y1 = Math.min(height, y0 + rowsPerChunk);
    callback(y0, y1);
    await yieldWorker(id);
  }
}

function smoothstep(x, a, b) {
  const t = clamp((x - a) / Math.max(1e-6, b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function percentile(values, p) {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  const i = clamp(
    Math.round((p / 100) * (values.length - 1)),
    0,
    values.length - 1
  );
  return values[i];
}

function robustUnit(input, lo, hi) {
  const sample = [];
  const step = Math.max(1, Math.floor(input.length / 20000));
  for (let i = 0; i < input.length; i += step) {
    const v = input[i];
    if (Number.isFinite(v)) sample.push(v);
  }

  const low = percentile(sample, lo);
  const high = percentile(sample, hi);
  const span = Math.max(1e-6, high - low);

  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    out[i] = clamp((input[i] - low) / span, 0, 1);
  }
  return out;
}

function gaussianKernel1D(sigma) {
  sigma = Math.max(0.1, sigma);
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const size = radius * 2 + 1;
  const kernel = new Float32Array(size);
  let sum = 0;

  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    sum += v;
  }

  for (let i = 0; i < size; i++) kernel[i] /= sum;
  return { kernel, radius };
}

async function gaussianBlur(id, input, width, height, sigma) {
  const { kernel, radius } = gaussianKernel1D(sigma);
  const temp = new Float32Array(input.length);
  const out = new Float32Array(input.length);

  await forRows(id, height, (y0, y1) => {
    for (let y = y0; y < y1; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          const xx = clamp(x + k, 0, width - 1);
          sum += input[row + xx] * kernel[k + radius];
        }
        temp[row + x] = sum;
      }
    }
  });

  await forRows(id, height, (y0, y1) => {
    for (let y = y0; y < y1; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          const yy = clamp(y + k, 0, height - 1);
          sum += temp[yy * width + x] * kernel[k + radius];
        }
        out[row + x] = sum;
      }
    }
  });

  return out;
}

async function boxBlur(id, input, width, height, radius) {
  const temp = new Float32Array(input.length);
  const out = new Float32Array(input.length);
  const size = radius * 2 + 1;

  await forRows(id, height, (y0, y1) => {
    for (let y = y0; y < y1; y++) {
      const row = y * width;
      let sum = 0;

      for (let k = -radius; k <= radius; k++) {
        sum += input[row + clamp(k, 0, width - 1)];
      }

      for (let x = 0; x < width; x++) {
        temp[row + x] = sum / size;
        const removeX = clamp(x - radius, 0, width - 1);
        const addX = clamp(x + radius + 1, 0, width - 1);
        sum += input[row + addX] - input[row + removeX];
      }
    }
  });

  await forRows(id, height, (y0, y1) => {
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          const yy = clamp(y + k, 0, height - 1);
          sum += temp[yy * width + x];
        }
        out[y * width + x] = sum / size;
      }
    }
  });

  return out;
}

async function sobelAndLaplacian(id, lum, width, height) {
  const gx = new Float32Array(lum.length);
  const gy = new Float32Array(lum.length);
  const mag = new Float32Array(lum.length);
  const lap = new Float32Array(lum.length);

  await forRows(id, height, (y0, y1) => {
    for (let y = y0; y < y1; y++) {
      const ym = Math.max(0, y - 1);
      const yp = Math.min(height - 1, y + 1);

      for (let x = 0; x < width; x++) {
        const xm = Math.max(0, x - 1);
        const xp = Math.min(width - 1, x + 1);

        const a = lum[ym * width + xm];
        const b = lum[ym * width + x];
        const c = lum[ym * width + xp];
        const d = lum[y * width + xm];
        const e = lum[y * width + x];
        const f = lum[y * width + xp];
        const g = lum[yp * width + xm];
        const h = lum[yp * width + x];
        const i = lum[yp * width + xp];

        const sx = -a + c - 2 * d + 2 * f - g + i;
        const sy = -a - 2 * b - c + g + 2 * h + i;

        const idx = y * width + x;
        gx[idx] = sx;
        gy[idx] = sy;
        mag[idx] = Math.hypot(sx, sy);
        lap[idx] = Math.abs(a + b + c + d - 8 * e + f + g + h + i);
      }
    }
  });

  return { gx, gy, mag, lap };
}

async function minMax3x3(id, input, width, height) {
  const openedBase = new Float32Array(input.length);
  const closedBase = new Float32Array(input.length);
  const opened = new Float32Array(input.length);
  const closed = new Float32Array(input.length);

  await forRows(id, height, (y0, y1) => {
    for (let y = y0; y < y1; y++) {
      const ym = Math.max(0, y - 1);
      const yp = Math.min(height - 1, y + 1);

      for (let x = 0; x < width; x++) {
        const xm = Math.max(0, x - 1);
        const xp = Math.min(width - 1, x + 1);

        let minV = Infinity;
        let maxV = -Infinity;

        for (let yy = ym; yy <= yp; yy++) {
          const row = yy * width;
          for (let xx = xm; xx <= xp; xx++) {
            const v = input[row + xx];
            minV = Math.min(minV, v);
            maxV = Math.max(maxV, v);
          }
        }

        const idx = y * width + x;
        openedBase[idx] = minV;
        closedBase[idx] = maxV;
      }
    }
  });

  await forRows(id, height, (y0, y1) => {
    for (let y = y0; y < y1; y++) {
      const ym = Math.max(0, y - 1);
      const yp = Math.min(height - 1, y + 1);

      for (let x = 0; x < width; x++) {
        const xm = Math.max(0, x - 1);
        const xp = Math.min(width - 1, x + 1);

        let maxOfMin = -Infinity;
        let minOfMax = Infinity;

        for (let yy = ym; yy <= yp; yy++) {
          const row = yy * width;
          for (let xx = xm; xx <= xp; xx++) {
            maxOfMin = Math.max(maxOfMin, openedBase[row + xx]);
            minOfMax = Math.min(minOfMax, closedBase[row + xx]);
          }
        }

        const idx = y * width + x;
        opened[idx] = maxOfMin;
        closed[idx] = minOfMax;
      }
    }
  });

  return { opened, closed };
}

async function processRequest(request) {
  const id = request.id;
  const width = request.width;
  const height = request.height;
  const pixels = new Uint8ClampedArray(request.pixels);
  const count = width * height;

  const cfg = {
    edgeCrunch: clamp(request.settings?.edgeCrunch ?? 0.55, 0, 1),
    fragmentSensitivity: clamp(
      request.settings?.fragmentSensitivity ?? 0.65,
      0,
      1
    ),
    structureProtection: clamp(
      request.settings?.structureProtection ?? 0.90,
      0,
      1
    ),
    crunchRadius: clamp(
      request.settings?.crunchRadius ?? 0.80,
      0.35,
      2.50
    ),
    baseCleanup: clamp(request.settings?.baseCleanup ?? 0.15, 0, 1),
    speckThreshold: Math.max(
      1,
      Math.round(request.settings?.speckThreshold ?? 10)
    ),
  };

  postProgress(id, "Background EdgeCrunch worker ready.");

  const lum = new Float32Array(count);
  const red = new Float32Array(count);
  const green = new Float32Array(count);
  const blue = new Float32Array(count);

  postProgress(id, "Reading image texture...");

  await forRows(id, height, (y0, y1) => {
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const i = p * 4;
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];

        red[p] = r;
        green[p] = g;
        blue[p] = b;
        lum[p] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      }
    }
  });

  postProgress(id, "Finding fragmented micro-edges...");

  const { gx, gy, mag, lap } = await sobelAndLaplacian(
    id,
    lum,
    width,
    height
  );

  const grad = robustUnit(mag, 5, 99.5);
  const highFreq = robustUnit(lap, 10, 97);

  const gx2 = new Float32Array(count);
  const gy2 = new Float32Array(count);
  const gxgy = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    gx2[i] = gx[i] * gx[i];
    gy2[i] = gy[i] * gy[i];
    gxgy[i] = gx[i] * gy[i];
  }

  const [jxx, jyy, jxy] = await Promise.all([
    gaussianBlur(id, gx2, width, height, 1.5),
    gaussianBlur(id, gy2, width, height, 1.5),
    gaussianBlur(id, gxgy, width, height, 1.5),
  ]);

  const coherence = new Float32Array(count);
  const medium = new Float32Array(count);
  const micro = new Float32Array(count);
  const seeds = new Float32Array(count);
  const threshold = 0.52 - 0.28 * cfg.fragmentSensitivity;

  await forRows(id, height, (y0, y1) => {
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const dx = jxx[p] - jyy[p];

        coherence[p] =
          Math.sqrt(dx * dx + 4 * jxy[p] * jxy[p]) /
          (jxx[p] + jyy[p] + 1e-6);

        medium[p] =
          smoothstep(grad[p], 0.06, 0.38) *
          (1 - smoothstep(grad[p], 0.70, 0.97));

        micro[p] =
          smoothstep(highFreq[p], 0.06, 0.50) *
          (1 - 0.20 * smoothstep(highFreq[p], 0.85, 1));

        seeds[p] =
          micro[p] > threshold && medium[p] > 0.12 ? 1 : 0;
      }
    }
  });

  const densityRaw = await boxBlur(id, seeds, width, height, 3);
  const mask = new Float32Array(count);
  const incoherentPower =
    0.55 + 1.65 * (1 - cfg.fragmentSensitivity);

  await forRows(id, height, (y0, y1) => {
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;

        const density = smoothstep(densityRaw[p], 0.04, 0.42);
        const incoherent = Math.pow(
          clamp(1 - coherence[p], 0, 1),
          incoherentPower
        );

        let value =
          (0.64 * micro[p] * medium[p] +
            0.36 * density * medium[p]) *
          (0.40 + 0.60 * incoherent);

        value *= clamp(
          1 -
            cfg.structureProtection *
              0.60 *
              coherence[p],
          0,
          1
        );

        value *= 1 - smoothstep(grad[p], 0.78, 0.98);

        const flatTexture =
          highFreq[p] *
          Math.pow(
            1 - smoothstep(grad[p], 0.35, 0.75),
            1.4
          );

        mask[p] = Math.max(
          value,
          cfg.baseCleanup * flatTexture
        );
      }
    }
  });

  const maskSmooth = await gaussianBlur(
    id,
    mask,
    width,
    height,
    0.5
  );

  postProgress(id, "Reconstructing targeted texture...");

  const [blurR, blurG, blurB] = await Promise.all([
    gaussianBlur(id, red, width, height, cfg.crunchRadius),
    gaussianBlur(id, green, width, height, cfg.crunchRadius),
    gaussianBlur(id, blue, width, height, cfg.crunchRadius),
  ]);

  const outR = new Float32Array(count);
  const outG = new Float32Array(count);
  const outB = new Float32Array(count);
  const cleanedLum = new Float32Array(count);

  await forRows(id, height, (y0, y1) => {
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const amount = clamp(
          cfg.edgeCrunch * maskSmooth[p] * 1.60,
          0,
          0.92
        );

        outR[p] = red[p] * (1 - amount) + blurR[p] * amount;
        outG[p] = green[p] * (1 - amount) + blurG[p] * amount;
        outB[p] = blue[p] * (1 - amount) + blurB[p] * amount;

        cleanedLum[p] =
          0.2126 * outR[p] +
          0.7152 * outG[p] +
          0.0722 * outB[p];
      }
    }
  });

  postProgress(id, "Cleaning specks...");

  const { opened, closed } = await minMax3x3(
    id,
    lum,
    width,
    height
  );

  const speckEnd = Math.max(
    cfg.speckThreshold + 8,
    cfg.speckThreshold * 2
  );

  await forRows(id, height, (y0, y1) => {
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;

        const bright = Math.max(lum[p] - opened[p], 0);
        const dark = Math.max(closed[p] - lum[p], 0);
        const hat = Math.max(bright, dark);

        let hatMask = smoothstep(
          hat,
          cfg.speckThreshold,
          speckEnd
        );

        hatMask *=
          maskSmooth[p] *
          cfg.edgeCrunch *
          0.22;

        const morphTarget =
          dark > bright ? closed[p] : opened[p];

        const delta =
          (morphTarget - cleanedLum[p]) * hatMask;

        outR[p] = clamp(outR[p] + delta, 0, 255);
        outG[p] = clamp(outG[p] + delta, 0, 255);
        outB[p] = clamp(outB[p] + delta, 0, 255);
      }
    }
  });

  postProgress(id, "Rendering background result...");

  const output = new Uint8ClampedArray(count * 4);
  const maskPixels = new Uint8ClampedArray(count * 4);

  await forRows(id, height, (y0, y1) => {
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const i = p * 4;

        const r = clamp(outR[p], 0, 255);
        const g = clamp(outG[p], 0, 255);
        const b = clamp(outB[p], 0, 255);
        const m = clamp(maskSmooth[p], 0, 1);

        output[i] = r;
        output[i + 1] = g;
        output[i + 2] = b;
        output[i + 3] = 255;

        maskPixels[i] = clamp(r * 0.50 + 255 * m * 0.50, 0, 255);
        maskPixels[i + 1] = clamp(g * 0.50, 0, 255);
        maskPixels[i + 2] = clamp(b * 0.50 + 120 * m * 0.50, 0, 255);
        maskPixels[i + 3] = 255;
      }
    }
  });

  if (isStale(id)) throw new CancelledError();

  self.postMessage(
    {
      type: "result",
      id,
      width,
      height,
      outputPixels: output.buffer,
      maskPixels: maskPixels.buffer,
    },
    [output.buffer, maskPixels.buffer]
  );
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
        if (error?.name === "CancelledError") continue;

        self.postMessage({
          type: "error",
          id: request.id,
          message: error?.message || String(error),
        });
      }
    }
  } finally {
    pumping = false;
    if (pendingRequest) pump();
  }
}

self.addEventListener("message", (event) => {
  const message = event.data || {};
  if (message.type !== "process") return;

  pendingRequest = message;
  pump();
});

// Immediate startup heartbeat. The main thread uses this to prove the worker loaded.
self.postMessage({ type: "worker-ready" });
