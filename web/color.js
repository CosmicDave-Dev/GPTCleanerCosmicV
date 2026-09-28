// CosmicV EdgeCrunch Darkroom Web
// Lightweight browser-side darkroom + display transforms.
// EdgeCrunch remains isolated in its background worker.

const clamp = (value, low, high) =>
  Math.max(low, Math.min(high, value));

function toCanvas(source) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  canvas.getContext("2d", { willReadFrequently: true }).drawImage(source, 0, 0);
  return canvas;
}

function hueRotateSaturate(r, g, b, hueDegrees, saturation) {
  let max = Math.max(r, g, b);
  let min = Math.min(r, g, b);
  let delta = max - min;

  let h = 0;
  let s = max <= 1e-6 ? 0 : delta / max;
  const v = max;

  if (delta > 1e-6) {
    if (max === r) {
      h = ((g - b) / delta) % 6;
    } else if (max === g) {
      h = (b - r) / delta + 2;
    } else {
      h = (r - g) / delta + 4;
    }
    h /= 6;
    if (h < 0) h += 1;
  }

  h = (h + hueDegrees / 360) % 1;
  if (h < 0) h += 1;
  s = clamp(s * saturation, 0, 1);

  const sector = h * 6;
  const i = Math.floor(sector);
  const f = sector - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));

  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

export function applyDarkroom(source, settings = {}) {
  const original = toCanvas(source);
  const work = toCanvas(source);
  const ctx = work.getContext("2d", { willReadFrequently: true });

  const brightness = clamp(settings.brightness ?? 0, -1, 1);
  const contrast = clamp(settings.contrast ?? 1, 0, 2);
  const saturation = clamp(settings.saturation ?? 1, 0, 2);
  const warmth = clamp(settings.warmth ?? 0, -1, 1);
  const exposure = clamp(settings.exposure ?? 0, -2, 2);
  const gamma = clamp(settings.gamma ?? 1, 0.4, 2.5);
  const hueDegrees = clamp(settings.hueDegrees ?? 0, -180, 180);
  const mix = clamp(settings.mix ?? 1, 0, 1);
  const grayscale = Boolean(settings.grayscale);
  const sepia = Boolean(settings.sepia);
  const invert = Boolean(settings.invert);
  const blurRadius = clamp(settings.blurRadius ?? 0, 0, 3);
  const sharpen = clamp(settings.sharpen ?? 0, 0, 2);
  const vignette = clamp(settings.vignette ?? 0, 0, 1);

  const neutralColor =
    Math.abs(brightness) < 1e-6 &&
    Math.abs(contrast - 1) < 1e-6 &&
    Math.abs(saturation - 1) < 1e-6 &&
    Math.abs(warmth) < 1e-6 &&
    Math.abs(exposure) < 1e-6 &&
    Math.abs(gamma - 1) < 1e-6 &&
    Math.abs(hueDegrees) < 1e-6 &&
    !grayscale &&
    !sepia &&
    !invert;

  if (!neutralColor) {
    const imageData = ctx.getImageData(0, 0, work.width, work.height);
    const data = imageData.data;
    const exposureFactor = Math.pow(2, exposure);
    const invGamma = 1 / gamma;
    const brightAdd = brightness * 0.35;

    for (let i = 0; i < data.length; i += 4) {
      let r = data[i] / 255;
      let g = data[i + 1] / 255;
      let b = data[i + 2] / 255;

      r = (r * exposureFactor + brightAdd - 0.5) * contrast + 0.5;
      g = (g * exposureFactor + brightAdd - 0.5) * contrast + 0.5;
      b = (b * exposureFactor + brightAdd - 0.5) * contrast + 0.5;

      r = Math.pow(clamp(r, 0, 1), invGamma);
      g = Math.pow(clamp(g, 0, 1), invGamma);
      b = Math.pow(clamp(b, 0, 1), invGamma);

      r = clamp(r + 0.18 * warmth, 0, 1);
      g = clamp(g + 0.025 * warmth, 0, 1);
      b = clamp(b - 0.18 * warmth, 0, 1);

      [r, g, b] = hueRotateSaturate(
        r,
        g,
        b,
        hueDegrees,
        saturation
      );

      if (grayscale) {
        const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = g = b = gray;
      }

      if (sepia) {
        const rr = clamp(0.393 * r + 0.769 * g + 0.189 * b, 0, 1);
        const gg = clamp(0.349 * r + 0.686 * g + 0.168 * b, 0, 1);
        const bb = clamp(0.272 * r + 0.534 * g + 0.131 * b, 0, 1);
        r = rr;
        g = gg;
        b = bb;
      }

      if (invert) {
        r = 1 - r;
        g = 1 - g;
        b = 1 - b;
      }

      data[i] = Math.round(r * 255);
      data[i + 1] = Math.round(g * 255);
      data[i + 2] = Math.round(b * 255);
    }

    ctx.putImageData(imageData, 0, 0);
  }

  if (blurRadius > 0.02) {
    const blurred = document.createElement("canvas");
    blurred.width = work.width;
    blurred.height = work.height;
    const bctx = blurred.getContext("2d");
    bctx.filter = `blur(${blurRadius}px)`;
    bctx.drawImage(work, 0, 0);
    ctx.clearRect(0, 0, work.width, work.height);
    ctx.filter = "none";
    ctx.drawImage(blurred, 0, 0);
  }

  if (sharpen > 0.001) {
    const soft = document.createElement("canvas");
    soft.width = work.width;
    soft.height = work.height;
    const sctx = soft.getContext("2d", { willReadFrequently: true });
    sctx.filter = "blur(1px)";
    sctx.drawImage(work, 0, 0);

    const baseData = ctx.getImageData(0, 0, work.width, work.height);
    const softData = sctx.getImageData(0, 0, work.width, work.height);
    const base = baseData.data;
    const blur = softData.data;

    for (let i = 0; i < base.length; i += 4) {
      base[i] = clamp(base[i] + sharpen * (base[i] - blur[i]), 0, 255);
      base[i + 1] = clamp(
        base[i + 1] + sharpen * (base[i + 1] - blur[i + 1]),
        0,
        255
      );
      base[i + 2] = clamp(
        base[i + 2] + sharpen * (base[i + 2] - blur[i + 2]),
        0,
        255
      );
    }

    ctx.putImageData(baseData, 0, 0);
  }

  if (vignette > 0.001) {
    const radius = Math.hypot(work.width, work.height) * 0.55;
    const gradient = ctx.createRadialGradient(
      work.width / 2,
      work.height / 2,
      radius * 0.18,
      work.width / 2,
      work.height / 2,
      radius
    );
    gradient.addColorStop(0, "rgba(0,0,0,0)");
    gradient.addColorStop(
      1,
      `rgba(0,0,0,${clamp(vignette * 0.62, 0, 0.62)})`
    );
    ctx.save();
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, work.width, work.height);
    ctx.restore();
  }

  if (mix >= 0.999) return work;
  if (mix <= 0.001) return original;

  const mixed = document.createElement("canvas");
  mixed.width = work.width;
  mixed.height = work.height;
  const mctx = mixed.getContext("2d");
  mctx.drawImage(original, 0, 0);
  mctx.globalAlpha = mix;
  mctx.drawImage(work, 0, 0);
  mctx.globalAlpha = 1;
  return mixed;
}

export function transformImage(
  source,
  rotateQuadrants = 0,
  flipHorizontal = false,
  flipVertical = false
) {
  const turns = ((Math.round(rotateQuadrants) % 4) + 4) % 4;
  const swap = turns % 2 === 1;

  const canvas = document.createElement("canvas");
  canvas.width = swap ? source.height : source.width;
  canvas.height = swap ? source.width : source.height;

  const ctx = canvas.getContext("2d");
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(flipHorizontal ? -1 : 1, flipVertical ? -1 : 1);
  ctx.rotate(turns * Math.PI / 2);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);

  return canvas;
}
