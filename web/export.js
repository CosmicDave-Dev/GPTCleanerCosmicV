function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function saveCanvasAs(
  canvas,
  format,
  quality = 0.95,
  baseName = "cosmicv-export"
) {
  if (!canvas) throw new Error("No image is loaded.");

  const formats = {
    png: { mime: "image/png", ext: "png" },
    jpeg: { mime: "image/jpeg", ext: "jpg" },
    webp: { mime: "image/webp", ext: "webp" },
  };

  const selected = formats[format] || formats.png;

  const blob = await new Promise((resolve) => {
    canvas.toBlob(resolve, selected.mime, quality);
  });

  if (!blob) {
    throw new Error(`This browser could not encode ${selected.mime}.`);
  }

  const safeBase = String(baseName)
    .replace(/[^a-z0-9._-]+/gi, "_")
    .replace(/^_+|_+$/g, "") || "cosmicv-export";
  downloadBlob(blob, `${safeBase}.${selected.ext}`);
}
