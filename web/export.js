const FORMATS = {
  png: {
    mime: "image/png",
    ext: "png",
    label: "PNG",
    pickerDescription: "PNG image",
    pickerExtensions: [".png"],
  },
  jpeg: {
    mime: "image/jpeg",
    ext: "jpg",
    label: "JPEG",
    pickerDescription: "JPEG image",
    pickerExtensions: [".jpg", ".jpeg"],
  },
  webp: {
    mime: "image/webp",
    ext: "webp",
    label: "WebP",
    pickerDescription: "WebP image",
    pickerExtensions: [".webp"],
  },
};

function safeBaseName(baseName) {
  return (
    String(baseName)
      .replace(/[^a-z0-9._-]+/gi, "_")
      .replace(/^_+|_+$/g, "") || "cosmicv-export"
  );
}

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

export function formatInfo(format) {
  return FORMATS[format] || FORMATS.png;
}

export async function chooseSaveTarget(
  format,
  baseName = "cosmicv-export"
) {
  const selected = formatInfo(format);
  const safeBase = safeBaseName(baseName);
  const suggestedName = `${safeBase}.${selected.ext}`;

  if (typeof window.showSaveFilePicker !== "function") {
    return {
      fileHandle: null,
      filename: suggestedName,
      format,
    };
  }

  try {
    const fileHandle = await window.showSaveFilePicker({
      suggestedName,
      types: [
        {
          description: selected.pickerDescription,
          accept: {
            [selected.mime]: selected.pickerExtensions,
          },
        },
      ],
      excludeAcceptAllOption: false,
    });

    return {
      fileHandle,
      filename: fileHandle.name || suggestedName,
      format,
    };
  } catch (error) {
    if (error?.name === "AbortError") return null;
    throw error;
  }
}

export async function encodeCanvas(
  canvas,
  format,
  quality = 0.95
) {
  if (!canvas) throw new Error("No image is loaded.");

  const selected = formatInfo(format);

  const blob = await new Promise((resolve) => {
    canvas.toBlob(resolve, selected.mime, quality);
  });

  if (!blob) {
    throw new Error(
      `This browser could not encode ${selected.mime}.`
    );
  }

  return blob;
}

export async function writeEncodedBlob(
  blob,
  {
    format = "png",
    baseName = "cosmicv-export",
    fileHandle = null,
    filename = null,
  } = {}
) {
  const selected = formatInfo(format);
  const safeBase = safeBaseName(baseName);
  const fallbackName =
    filename || `${safeBase}.${selected.ext}`;

  if (fileHandle) {
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();

    return {
      mode: "file-handle",
      filename: fileHandle.name || fallbackName,
      fileHandle,
      format,
    };
  }

  downloadBlob(blob, fallbackName);

  return {
    mode: "download",
    filename: fallbackName,
    fileHandle: null,
    format,
  };
}

export async function saveCanvasAs(
  canvas,
  format,
  quality = 0.95,
  baseName = "cosmicv-export",
  target = null
) {
  const blob = await encodeCanvas(canvas, format, quality);

  return writeEncodedBlob(blob, {
    format,
    baseName,
    fileHandle: target?.fileHandle || null,
    filename: target?.filename || null,
  });
}
