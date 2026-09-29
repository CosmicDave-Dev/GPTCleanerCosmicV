import { SplitViewer } from "./viewer.js";
import {
  chooseSaveTarget,
  saveCanvasAs,
} from "./export.js";
import { setStatus } from "./ui.js";
import {
  PRESETS,
  processImage,
  processFullResolutionTiled,
} from "./edgecrunch.js";
import {
  applyDarkroom,
  applyDarkroomAsync,
  transformImage,
} from "./color.js";

const $ = (id) => document.getElementById(id);

const fileInput = $("fileInput");
const openBtn = $("openBtn");
const topOpenBtn = $("topOpenBtn");
const clearBtn = $("clearBtn");
const fitBtn = $("fitBtn");
const oneToOneBtn = $("oneToOneBtn");
const toggleSplitBtn = $("toggleSplitBtn");
const targetMaskBtn = $("targetMaskBtn");
const topTargetMaskBtn = $("topTargetMaskBtn");
const infoBtn = $("infoBtn");
const fullscreenBtn = $("fullscreenBtn");
const swapBtn = $("swapBtn");
const saveBtn = $("saveBtn");
const saveAsBtn = $("saveAsBtn");
const saveAsMenu = $("saveAsMenu");
const statusText = $("statusText");
const dropZone = $("dropZone");
const fallbackSaveDialog = $("fallbackSaveDialog");
const fallbackSaveName = $("fallbackSaveName");
const fallbackSaveCancel = $("fallbackSaveCancel");
const fallbackSaveConfirm = $("fallbackSaveConfirm");

const viewer = new SplitViewer(
  $("viewerCanvas"),
  $("divider"),
  $("beforeTag"),
  $("afterTag"),
  $("emptyState")
);

const PREVIEW_MAX_SIDE = 1024;

let sourceOriginalBitmap = null;
let sourceBitmap = null;
let sourceName = "image";
let edgeBaseCanvas = null;
let maskBaseCanvas = null;
let processTimer = null;
let darkroomTimer = null;
let processGeneration = 0;
let previewBusy = false;
let exportBusy = false;
let lastSaveChoice = null;

const transformState = {
  turns: 0,
  flipHorizontal: false,
  flipVertical: false,
};

const cleanupControls = {
  edgeCrunch: {
    range: $("edgeCrunchRange"),
    number: $("edgeCrunchValue"),
    scale: 100,
  },
  fragmentSensitivity: {
    range: $("fragmentRange"),
    number: $("fragmentValue"),
    scale: 100,
  },
  structureProtection: {
    range: $("protectRange"),
    number: $("protectValue"),
    scale: 100,
  },
  crunchRadius: {
    range: $("radiusRange"),
    number: $("radiusValue"),
    scale: 1,
  },
  baseCleanup: {
    range: $("baseRange"),
    number: $("baseValue"),
    scale: 100,
  },
  speckThreshold: {
    range: $("speckRange"),
    number: $("speckValue"),
    scale: 1,
  },
};

const darkroomPairs = [
  ["hueRange", "hueValue"],
  ["mixRange", "mixValue"],
  ["brightnessRange", "brightnessValue"],
  ["contrastRange", "contrastValue"],
  ["saturationRange", "saturationValue"],
  ["warmthRange", "warmthValue"],
  ["exposureRange", "exposureValue"],
  ["gammaRange", "gammaValue"],
  ["blurRange", "blurValue"],
  ["sharpenRange", "sharpenValue"],
  ["vignetteRange", "vignetteValue"],
];

function cleanupSettingsFromControls() {
  const result = {};

  for (const [key, control] of Object.entries(cleanupControls)) {
    result[key] = Number(control.range.value) / control.scale;
  }

  result.speckThreshold = Math.round(result.speckThreshold);
  return result;
}

function darkroomSettingsFromControls() {
  return {
    hueDegrees: Number($("hueRange").value),
    mix: Number($("mixRange").value) / 100,
    brightness: Number($("brightnessRange").value) / 100,
    contrast: Number($("contrastRange").value) / 100,
    saturation: Number($("saturationRange").value) / 100,
    warmth: Number($("warmthRange").value) / 100,
    exposure: Number($("exposureRange").value),
    gamma: Number($("gammaRange").value),
    grayscale: $("grayscaleCheck").checked,
    sepia: $("sepiaCheck").checked,
    invert: $("invertCheck").checked,
    blurRadius: Number($("blurRange").value),
    sharpen: Number($("sharpenRange").value),
    vignette: Number($("vignetteRange").value) / 100,
  };
}

function drawHueWheel() {
  const canvas = $("hueWheel");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const cx = width / 2;
  const cy = height / 2;
  const outer = Math.min(width, height) * 0.46;
  const inner = outer * 0.58;

  ctx.clearRect(0, 0, width, height);

  for (let degree = 0; degree < 360; degree += 2) {
    const start = (degree - 90) * Math.PI / 180;
    const end = (degree + 2 - 90) * Math.PI / 180;

    ctx.beginPath();
    ctx.arc(cx, cy, outer, start, end);
    ctx.arc(cx, cy, inner, end, start, true);
    ctx.closePath();
    ctx.fillStyle = `hsl(${degree} 100% 55%)`;
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(cx, cy, inner - 2, 0, Math.PI * 2);
  ctx.fillStyle = "#0b111b";
  ctx.fill();
  ctx.strokeStyle = "#263248";
  ctx.lineWidth = 2;
  ctx.stroke();

  const hue = Number($("hueRange").value);
  const angle = ((hue + 180) / 360) * Math.PI * 2 - Math.PI / 2;
  const radius = (outer + inner) / 2;
  const px = cx + Math.cos(angle) * radius;
  const py = cy + Math.sin(angle) * radius;

  ctx.beginPath();
  ctx.arc(px, py, 6, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = "#061018";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = "#8fa0bd";
  ctx.font = "12px Segoe UI, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`${Math.round(hue)}°`, cx, cy);
}

function setHueFromPointer(event) {
  const canvas = $("hueWheel");
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left - rect.width / 2;
  const y = event.clientY - rect.top - rect.height / 2;
  let angle = Math.atan2(y, x) + Math.PI / 2;

  while (angle < 0) angle += Math.PI * 2;
  while (angle >= Math.PI * 2) angle -= Math.PI * 2;

  const hue = Math.round((angle / (Math.PI * 2)) * 360 - 180);
  $("hueRange").value = String(hue);
  $("hueValue").value = String(hue);
  drawHueWheel();
  scheduleDarkroom(40);
}

function displayCleanupValue(key, value) {
  if (key === "crunchRadius") return Number(value).toFixed(2);
  return String(Math.round(value));
}

function applyCleanupSettings(settings) {
  for (const [key, control] of Object.entries(cleanupControls)) {
    const raw = settings[key] * control.scale;
    control.range.value = String(raw);
    control.number.value = displayCleanupValue(key, raw);
  }
}

function markPreset(name) {
  document.querySelectorAll(".preset-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.preset === name);
  });
}

function markCustom() {
  document.querySelectorAll(".preset-btn").forEach((button) => {
    button.classList.remove("active");
  });
}

function updateBusyUi() {
  document.body.classList.toggle("processing", previewBusy);
  document.body.classList.toggle("exporting", exportBusy);

  const disableSaves = previewBusy || exportBusy;
  saveBtn.disabled = disableSaves;
  saveAsBtn.disabled = disableSaves;

  if (disableSaves) {
    saveAsMenu.classList.add("hidden");
  }

  openBtn.disabled = exportBusy;
  clearBtn.disabled = exportBusy;
}

function setBusy(busy) {
  previewBusy = busy;
  updateBusyUi();
}

function setExportBusy(busy) {
  exportBusy = busy;
  updateBusyUi();
}

function scheduleProcess(delay = 260) {
  if (!sourceBitmap) return;
  if (processTimer) clearTimeout(processTimer);

  processTimer = setTimeout(() => {
    processTimer = null;
    processCurrent(true);
  }, delay);
}

function scheduleDarkroom(delay = 80) {
  if (!sourceBitmap) return;
  if (darkroomTimer) clearTimeout(darkroomTimer);

  darkroomTimer = setTimeout(() => {
    darkroomTimer = null;
    refreshDisplay(true);
  }, delay);
}

function refreshDisplay(preserveView = true) {
  if (!sourceBitmap) return;

  const cleanedSource = edgeBaseCanvas || sourceBitmap;
  const adjusted = applyDarkroom(
    cleanedSource,
    darkroomSettingsFromControls()
  );

  const beforeDisplay = transformImage(
    sourceBitmap,
    transformState.turns,
    transformState.flipHorizontal,
    transformState.flipVertical
  );

  const afterDisplay = transformImage(
    adjusted,
    transformState.turns,
    transformState.flipHorizontal,
    transformState.flipVertical
  );

  const maskDisplay = maskBaseCanvas
    ? transformImage(
        maskBaseCanvas,
        transformState.turns,
        transformState.flipHorizontal,
        transformState.flipVertical
      )
    : null;

  viewer.setImages(
    beforeDisplay,
    afterDisplay,
    maskDisplay,
    preserveView
  );
}

async function processCurrent(preserveView = true) {
  if (!sourceBitmap) return;

  const generation = ++processGeneration;
  const settings = cleanupSettingsFromControls();
  setBusy(true);

  try {
    const result = await processImage(
      sourceBitmap,
      settings,
      (message) => setStatus(statusText, message)
    );

    if (generation !== processGeneration) return;

    edgeBaseCanvas = result.outputCanvas;
    maskBaseCanvas = result.targetMaskCanvas;

    refreshDisplay(preserveView);

    setStatus(
      statusText,
      `EdgeCrunch ready · ${sourceName} · drag cyan divider to compare`
    );
  } catch (error) {
    if (
      generation !== processGeneration ||
      error?.name === "AbortError"
    ) {
      return;
    }

    console.error(error);
    setStatus(statusText, `EdgeCrunch failed: ${error.message}`);
  } finally {
    if (generation === processGeneration) setBusy(false);
  }
}

async function makeProcessingBitmap(bitmap) {
  const maxSide = Math.max(bitmap.width, bitmap.height);

  if (maxSide <= PREVIEW_MAX_SIDE) {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    return createImageBitmap(canvas);
  }

  const scale = PREVIEW_MAX_SIDE / maxSide;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);

  return createImageBitmap(canvas);
}

async function loadFile(file) {
  if (exportBusy) {
    setStatus(
      statusText,
      "Full-resolution export is still running. Let it finish before opening another image."
    );
    return;
  }

  if (!file?.type?.startsWith("image/")) {
    setStatus(statusText, "That file does not look like an image.");
    return;
  }

  try {
    setStatus(statusText, `Loading ${file.name}...`);

    processGeneration++;
    viewer.clear();

    sourceOriginalBitmap?.close?.();
    sourceBitmap?.close?.();

    sourceOriginalBitmap = await createImageBitmap(file);
    sourceBitmap = await makeProcessingBitmap(sourceOriginalBitmap);
    sourceName = file.name.replace(/\.[^.]+$/, "") || "image";
    lastSaveChoice = null;
    edgeBaseCanvas = null;
    maskBaseCanvas = null;

    refreshDisplay(false);

    const reduced =
      sourceBitmap.width !== sourceOriginalBitmap.width ||
      sourceBitmap.height !== sourceOriginalBitmap.height;

    setStatus(
      statusText,
      reduced
        ? `Loaded ${file.name}. Browser preview scaled to ${sourceBitmap.width}×${sourceBitmap.height}; EdgeCrunch is running in the background...`
        : `Loaded ${file.name}. EdgeCrunch is running in the background...`
    );

    await new Promise((resolve) =>
      requestAnimationFrame(() => resolve())
    );

    await processCurrent(true);
  } catch (error) {
    console.error(error);
    setStatus(statusText, `Failed to load image: ${error.message}`);
  }
}

function bindRangeNumber(rangeId, numberId, onChange) {
  const range = $(rangeId);
  const number = $(numberId);

  const format = (value) => {
    const step = Number(range.step || 1);
    if (step < 1) {
      const decimals = step < 0.1 ? 2 : 1;
      return Number(value).toFixed(decimals);
    }
    return String(Math.round(Number(value)));
  };

  range.addEventListener("input", () => {
    number.value = format(range.value);
    onChange();
  });

  const commit = () => {
    const min = Number(range.min);
    const max = Number(range.max);
    let value = Number(number.value);

    if (!Number.isFinite(value)) value = Number(range.value);
    value = Math.max(min, Math.min(max, value));

    range.value = String(value);
    number.value = format(value);
    onChange();
  };

  number.addEventListener("change", commit);
  number.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
      number.blur();
    }
  });
}

for (const button of document.querySelectorAll(".tab-btn")) {
  button.addEventListener("click", () => {
    const tab = button.dataset.tab;

    document.querySelectorAll(".tab-btn").forEach((candidate) => {
      candidate.classList.toggle("active", candidate === button);
    });

    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.panel === tab);
    });
  });
}

for (const button of document.querySelectorAll(".preset-btn")) {
  button.addEventListener("click", () => {
    const name = button.dataset.preset;
    const preset = PRESETS[name];
    if (!preset) return;

    applyCleanupSettings(preset);
    markPreset(name);
    setStatus(statusText, `${name} preset selected.`);
    scheduleProcess(40);
  });
}

for (const [key, control] of Object.entries(cleanupControls)) {
  bindRangeNumber(
    control.range.id,
    control.number.id,
    () => {
      control.number.value = displayCleanupValue(
        key,
        control.range.value
      );
      markCustom();
      scheduleProcess();
    }
  );
}

for (const button of document.querySelectorAll(".control-info-btn")) {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();

    const title = button.dataset.helpTitle || "Cleanup control";
    const help = button.dataset.help || button.title || "";
    setStatus(statusText, `${title}: ${help}`);
  });
}

$("resetCleanupBtn").addEventListener("click", () => {
  applyCleanupSettings(PRESETS.Balanced);
  markPreset("Balanced");
  scheduleProcess(40);
  setStatus(statusText, "Cleanup reset to Balanced.");
});

for (const [rangeId, numberId] of darkroomPairs) {
  bindRangeNumber(rangeId, numberId, () => {
    if (rangeId === "hueRange") drawHueWheel();
    scheduleDarkroom();
  });
}

const hueWheel = $("hueWheel");
hueWheel.addEventListener("pointerdown", (event) => {
  hueWheel.setPointerCapture?.(event.pointerId);
  setHueFromPointer(event);
});
hueWheel.addEventListener("pointermove", (event) => {
  if (event.buttons & 1) setHueFromPointer(event);
});

for (const id of [
  "grayscaleCheck",
  "sepiaCheck",
  "invertCheck",
]) {
  $(id).addEventListener("change", () => {
    scheduleDarkroom(0);
  });
}

$("resetColorBtn").addEventListener("click", () => {
  const defaults = {
    hueRange: 0,
    mixRange: 100,
    brightnessRange: 0,
    contrastRange: 100,
    saturationRange: 100,
    warmthRange: 0,
    exposureRange: 0,
    gammaRange: 1,
  };

  for (const [rangeId, value] of Object.entries(defaults)) {
    const range = $(rangeId);
    const number = $(
      rangeId.replace("Range", "Value")
    );
    range.value = String(value);
    number.value = String(value);
  }

  drawHueWheel();
  scheduleDarkroom(0);
  setStatus(statusText, "Color controls reset.");
});

$("resetEffectsBtn").addEventListener("click", () => {
  $("grayscaleCheck").checked = false;
  $("sepiaCheck").checked = false;
  $("invertCheck").checked = false;

  for (const [rangeId, value] of [
    ["blurRange", 0],
    ["sharpenRange", 0],
    ["vignetteRange", 0],
  ]) {
    const range = $(rangeId);
    const number = $(
      rangeId.replace("Range", "Value")
    );
    range.value = String(value);
    number.value = String(value);
  }

  scheduleDarkroom(0);
  setStatus(statusText, "Effects reset.");
});

function updateTransformStatus() {
  const labels = [0, 90, 180, -90];
  $("rotationStatus").textContent =
    `Rotation: ${labels[transformState.turns]}°`;
}

function applyTransformState() {
  transformState.flipHorizontal = $("flipHCheck").checked;
  transformState.flipVertical = $("flipVCheck").checked;
  updateTransformStatus();
  refreshDisplay(false);
}

$("rotateLeftBtn").addEventListener("click", () => {
  transformState.turns =
    (transformState.turns + 3) % 4;
  applyTransformState();
});

$("rotateRightBtn").addEventListener("click", () => {
  transformState.turns =
    (transformState.turns + 1) % 4;
  applyTransformState();
});

$("flipHCheck").addEventListener("change", applyTransformState);
$("flipVCheck").addEventListener("change", applyTransformState);

$("resetTransformBtn").addEventListener("click", () => {
  transformState.turns = 0;
  $("flipHCheck").checked = false;
  $("flipVCheck").checked = false;
  applyTransformState();
  setStatus(statusText, "Transform reset.");
});

openBtn.addEventListener("click", () => fileInput.click());
topOpenBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (file) await loadFile(file);
  fileInput.value = "";
});

clearBtn.addEventListener("click", () => {
  if (exportBusy) return;
  processGeneration++;
  sourceOriginalBitmap?.close?.();
  sourceOriginalBitmap = null;
  sourceBitmap = null;
  lastSaveChoice = null;
  saveAsMenu.classList.add("hidden");
  edgeBaseCanvas = null;
  maskBaseCanvas = null;
  viewer.clear();
  setBusy(false);
  setStatus(statusText, "Workspace cleared.");
});

fitBtn.addEventListener("click", () => {
  viewer.fitToView();
  setStatus(statusText, "View: Fit");
});

oneToOneBtn.addEventListener("click", () => {
  viewer.oneToOne();
  setStatus(statusText, "View: 1:1");
});

toggleSplitBtn.addEventListener("click", () => {
  viewer.toggleSplit();
  setStatus(statusText, "Split view toggled.");
});

function toggleTargetMask() {
  const showing = viewer.toggleTargetMask();

  targetMaskBtn.classList.toggle("btn-accent", showing);
  topTargetMaskBtn.classList.toggle("top-action-accent", showing);
  targetMaskBtn.setAttribute("aria-pressed", String(showing));
  topTargetMaskBtn.setAttribute("aria-pressed", String(showing));

  setStatus(
    statusText,
    showing
      ? "Target Mask shown. Red/magenta areas receive more cleanup."
      : "Target Mask hidden."
  );
}

targetMaskBtn.addEventListener("click", toggleTargetMask);
topTargetMaskBtn.addEventListener("click", toggleTargetMask);

infoBtn.addEventListener("click", () => {
  setStatus(
    statusText,
    "CosmicV EdgeCrunch Darkroom Web V1.0 · local browser processing · no image uploads · free, no account, no ads."
  );
});

function updateFullscreenButton() {
  fullscreenBtn.textContent = document.fullscreenElement
    ? "Exit Fullscreen"
    : "F11 Fullscreen";
  fullscreenBtn.classList.toggle(
    "top-action-accent",
    Boolean(document.fullscreenElement)
  );
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch (error) {
    console.error(error);
    setStatus(
      statusText,
      "Fullscreen could not be opened here. Your browser's F11 key can still toggle browser fullscreen."
    );
  }
}

fullscreenBtn.addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", updateFullscreenButton);

swapBtn.addEventListener("click", () => {
  viewer.swapImages();
  setStatus(statusText, "Before / After swapped.");
});

function qualityForFormat(format) {
  return format === "png" ? 0.95 : 0.96;
}

function extensionForFormat(format) {
  if (format === "jpeg") return ".jpg";
  if (format === "webp") return ".webp";
  return ".png";
}

function normalizeFallbackFilename(filename, format) {
  const ext = extensionForFormat(format);
  const trimmed = String(filename || "").trim();

  if (!trimmed) {
    return `${sourceName}_cosmicv${ext}`;
  }

  const withoutKnownExtension = trimmed.replace(
    /\.(png|jpe?g|webp)$/i,
    ""
  );

  return `${withoutKnownExtension}${ext}`;
}

function requestFallbackFilename(suggestedName, format) {
  return new Promise((resolve) => {
    fallbackSaveName.value = suggestedName;
    fallbackSaveDialog.classList.remove("hidden");

    const cleanup = () => {
      fallbackSaveDialog.classList.add("hidden");
      fallbackSaveCancel.removeEventListener("click", onCancel);
      fallbackSaveConfirm.removeEventListener("click", onConfirm);
      fallbackSaveName.removeEventListener("keydown", onKeyDown);
    };

    const onCancel = () => {
      cleanup();
      resolve(null);
    };

    const onConfirm = () => {
      const filename = normalizeFallbackFilename(
        fallbackSaveName.value,
        format
      );
      cleanup();
      resolve(filename);
    };

    const onKeyDown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        onConfirm();
      } else if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };

    fallbackSaveCancel.addEventListener("click", onCancel);
    fallbackSaveConfirm.addEventListener("click", onConfirm);
    fallbackSaveName.addEventListener("keydown", onKeyDown);

    queueMicrotask(() => {
      fallbackSaveName.focus();
      fallbackSaveName.select();
    });
  });
}

function toggleSaveAsMenu(forceOpen = null) {
  if (!sourceOriginalBitmap) {
    saveAsMenu.classList.add("hidden");
    setStatus(statusText, "Open an image first.");
    return;
  }

  const shouldOpen =
    forceOpen === null
      ? saveAsMenu.classList.contains("hidden")
      : Boolean(forceOpen);

  saveAsMenu.classList.toggle("hidden", !shouldOpen);
}

async function save(
  format,
  quality,
  target = null,
  rememberChoice = true
) {
  if (!sourceOriginalBitmap || exportBusy) {
    if (!sourceOriginalBitmap) {
      setStatus(statusText, "Open an image first.");
    }
    return false;
  }

  const cleanupSnapshot = cleanupSettingsFromControls();
  const darkroomSnapshot = darkroomSettingsFromControls();
  const transformSnapshot = {
    turns: transformState.turns,
    flipHorizontal: transformState.flipHorizontal,
    flipVertical: transformState.flipVertical,
  };

  setExportBusy(true);

  try {
    setStatus(
      statusText,
      `Preparing full-resolution ${format.toUpperCase()} export from ${sourceOriginalBitmap.width}×${sourceOriginalBitmap.height} source...`
    );

    const cleanedFull = await processFullResolutionTiled(
      sourceOriginalBitmap,
      cleanupSnapshot,
      (message) => setStatus(statusText, message)
    );

    const darkroomFull = await applyDarkroomAsync(
      cleanedFull,
      darkroomSnapshot,
      (message) => setStatus(statusText, message)
    );

    setStatus(statusText, "Applying full-resolution transform...");

    const finalCanvas = transformImage(
      darkroomFull,
      transformSnapshot.turns,
      transformSnapshot.flipHorizontal,
      transformSnapshot.flipVertical
    );

    setStatus(
      statusText,
      `Encoding full-resolution ${format.toUpperCase()}...`
    );

    const written = await saveCanvasAs(
      finalCanvas,
      format,
      quality,
      `${sourceName}_cosmicv`,
      target
    );

    if (rememberChoice) {
      lastSaveChoice = {
        format,
        quality,
        target: {
          fileHandle: written.fileHandle || null,
          filename: written.filename,
        },
      };
    }

    setStatus(
      statusText,
      `Saved full-resolution ${format.toUpperCase()}: ${finalCanvas.width}×${finalCanvas.height}`
    );

    return true;
  } catch (error) {
    console.error(error);
    setStatus(
      statusText,
      `Full-resolution export failed: ${error.message}`
    );
    return false;
  } finally {
    setExportBusy(false);
  }
}

saveBtn.addEventListener("click", async () => {
  if (!sourceOriginalBitmap) {
    setStatus(statusText, "Open an image first.");
    return;
  }

  if (!lastSaveChoice) {
    toggleSaveAsMenu(true);
    setStatus(
      statusText,
      "Choose a format for the first save. After that, Save reuses it."
    );
    return;
  }

  await save(
    lastSaveChoice.format,
    lastSaveChoice.quality,
    lastSaveChoice.target,
    true
  );
});

saveAsBtn.addEventListener("click", () => {
  toggleSaveAsMenu();
});

for (const button of document.querySelectorAll(".save-format-btn")) {
  button.addEventListener("click", async () => {
    const format = button.dataset.format;
    const quality = qualityForFormat(format);

    saveAsMenu.classList.add("hidden");

    let target = await chooseSaveTarget(
      format,
      `${sourceName}_cosmicv`
    );

    if (!target) {
      setStatus(statusText, "Save As cancelled.");
      return;
    }

    if (target.needsFallbackDialog) {
      const filename = await requestFallbackFilename(
        target.filename,
        format
      );

      if (!filename) {
        setStatus(statusText, "Save As cancelled.");
        return;
      }

      target = {
        ...target,
        filename,
        needsFallbackDialog: false,
      };

      setStatus(
        statusText,
        "Firefox will use its Downloads setting for the destination. Enable “Always ask you where to save files” to choose a folder every time."
      );
    }

    await save(format, quality, target, true);
  });
}

document.addEventListener("pointerdown", (event) => {
  if (
    !saveAsMenu.classList.contains("hidden") &&
    !event.target.closest(".save-menu-wrap")
  ) {
    saveAsMenu.classList.add("hidden");
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    saveAsMenu.classList.add("hidden");
  }

  if (event.key === "F11") {
    event.preventDefault();
    toggleFullscreen();
  }
});

for (const eventName of ["dragenter", "dragover", "drop"]) {
  window.addEventListener(
    eventName,
    (event) => {
      event.preventDefault();
    },
    false
  );
}

for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("dragover");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragover");
  });
}

dropZone.addEventListener("drop", async (event) => {
  event.preventDefault();
  event.stopPropagation();
  const file = event.dataTransfer?.files?.[0];
  if (file) await loadFile(file);
});

applyCleanupSettings(PRESETS.Balanced);
markPreset("Balanced");
updateTransformStatus();
drawHueWheel();
updateBusyUi();
updateFullscreenButton();

setStatus(
  statusText,
  "Ready. Drop an image here or click Open Image."
);
