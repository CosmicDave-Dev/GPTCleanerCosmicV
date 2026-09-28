import { SplitViewer } from "./viewer.js";
import { saveCanvasAs } from "./export.js";
import { setStatus } from "./ui.js";
import { PRESETS, processImage } from "./edgecrunch.js";
import { applyDarkroom, transformImage } from "./color.js";

const $ = (id) => document.getElementById(id);

const fileInput = $("fileInput");
const openBtn = $("openBtn");
const clearBtn = $("clearBtn");
const fitBtn = $("fitBtn");
const oneToOneBtn = $("oneToOneBtn");
const toggleSplitBtn = $("toggleSplitBtn");
const targetMaskBtn = $("targetMaskBtn");
const swapBtn = $("swapBtn");
const savePngBtn = $("savePngBtn");
const saveJpegBtn = $("saveJpegBtn");
const saveWebpBtn = $("saveWebpBtn");
const statusText = $("statusText");
const dropZone = $("dropZone");

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

function setBusy(busy) {
  document.body.classList.toggle("processing", busy);

  for (const button of [
    savePngBtn,
    saveJpegBtn,
    saveWebpBtn,
  ]) {
    button.disabled = busy;
  }
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

$("resetCleanupBtn").addEventListener("click", () => {
  applyCleanupSettings(PRESETS.Balanced);
  markPreset("Balanced");
  scheduleProcess(40);
  setStatus(statusText, "Cleanup reset to Balanced.");
});

for (const [rangeId, numberId] of darkroomPairs) {
  bindRangeNumber(rangeId, numberId, () => {
    scheduleDarkroom();
  });
}

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
  $("rotationStatus").textContent =
    `Rotation: ${transformState.turns * 90}°`;
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

fileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (file) await loadFile(file);
  fileInput.value = "";
});

clearBtn.addEventListener("click", () => {
  processGeneration++;
  sourceOriginalBitmap?.close?.();
  sourceOriginalBitmap = null;
  sourceBitmap = null;
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

targetMaskBtn.addEventListener("click", () => {
  const showing = viewer.toggleTargetMask();
  targetMaskBtn.classList.toggle("btn-accent", showing);

  setStatus(
    statusText,
    showing
      ? "Target Mask shown. Red/magenta areas receive more cleanup."
      : "Target Mask hidden."
  );
});

swapBtn.addEventListener("click", () => {
  viewer.swapImages();
  setStatus(statusText, "Before / After swapped.");
});

async function save(format, quality) {
  try {
    const canvas = viewer.getCurrentOutputCanvas();

    if (!canvas) {
      setStatus(statusText, "Open an image first.");
      return;
    }

    await saveCanvasAs(
      canvas,
      format,
      quality,
      `${sourceName}_cosmicv`
    );

    setStatus(statusText, `Saved ${format.toUpperCase()}.`);
  } catch (error) {
    console.error(error);
    setStatus(statusText, `Save failed: ${error.message}`);
  }
}

savePngBtn.addEventListener("click", () => save("png"));
saveJpegBtn.addEventListener("click", () => save("jpeg", 0.96));
saveWebpBtn.addEventListener("click", () => save("webp", 0.96));

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

setStatus(
  statusText,
  "Ready. Drop an image here or click Open Image."
);
