import { SplitViewer } from "./viewer.js";
import { saveCanvasAs } from "./export.js";
import { setStatus } from "./ui.js";
import {
  PRESETS,
  processImage,
  waitForOpenCV,
} from "./edgecrunch.js";

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

let sourceBitmap = null;
let sourceName = "image";
let processTimer = null;
let processGeneration = 0;
let cvReady = false;

const controls = {
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

function settingsFromControls() {
  const result = {};
  for (const [key, control] of Object.entries(controls)) {
    result[key] = Number(control.range.value) / control.scale;
  }
  result.speckThreshold = Math.round(result.speckThreshold);
  return result;
}

function displayValue(key, value) {
  if (key === "crunchRadius") return Number(value).toFixed(2);
  return String(Math.round(value));
}

function applySettings(settings) {
  for (const [key, control] of Object.entries(controls)) {
    const raw = settings[key] * control.scale;
    control.range.value = String(raw);
    control.number.value = displayValue(key, raw);
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
    openBtn,
    clearBtn,
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

async function processCurrent(preserveView = true) {
  if (!sourceBitmap) return;

  const generation = ++processGeneration;
  const settings = settingsFromControls();
  setBusy(true);

  try {
    const result = await processImage(
      sourceBitmap,
      settings,
      (message) => setStatus(statusText, message)
    );

    if (generation !== processGeneration) return;

    const [afterBitmap, maskBitmap] = await Promise.all([
      createImageBitmap(result.outputCanvas),
      createImageBitmap(result.targetMaskCanvas),
    ]);

    if (generation !== processGeneration) {
      afterBitmap.close?.();
      maskBitmap.close?.();
      return;
    }

    viewer.setImages(
      sourceBitmap,
      afterBitmap,
      maskBitmap,
      preserveView
    );

    setStatus(
      statusText,
      `EdgeCrunch ready · ${sourceName} · drag cyan divider to compare`
    );
  } catch (error) {
    console.error(error);
    setStatus(statusText, `EdgeCrunch failed: ${error.message}`);
  } finally {
    if (generation === processGeneration) setBusy(false);
  }
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

    sourceBitmap = await createImageBitmap(file);
    sourceName = file.name.replace(/\.[^.]+$/, "") || "image";

    viewer.setImages(sourceBitmap, sourceBitmap, null, false);
    setStatus(statusText, "Image loaded. Running EdgeCrunch...");
    await processCurrent(true);
  } catch (error) {
    console.error(error);
    setStatus(statusText, `Failed to load image: ${error.message}`);
  }
}

for (const button of document.querySelectorAll(".preset-btn")) {
  button.addEventListener("click", () => {
    const name = button.dataset.preset;
    const preset = PRESETS[name];
    if (!preset) return;
    applySettings(preset);
    markPreset(name);
    setStatus(statusText, `${name} preset selected.`);
    scheduleProcess(40);
  });
}

for (const [key, control] of Object.entries(controls)) {
  control.range.addEventListener("input", () => {
    control.number.value = displayValue(key, control.range.value);
    markCustom();
    scheduleProcess();
  });

  const commitNumber = () => {
    const min = Number(control.range.min);
    const max = Number(control.range.max);
    let value = Number(control.number.value);

    if (!Number.isFinite(value)) value = Number(control.range.value);
    value = Math.max(min, Math.min(max, value));

    control.number.value = displayValue(key, value);
    control.range.value = String(value);
    markCustom();
    scheduleProcess();
  };

  control.number.addEventListener("change", commitNumber);
  control.number.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitNumber();
      control.number.blur();
    }
  });
}

openBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (file) await loadFile(file);
  fileInput.value = "";
});

clearBtn.addEventListener("click", () => {
  processGeneration++;
  sourceBitmap = null;
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
  const file = event.dataTransfer?.files?.[0];
  if (file) await loadFile(file);
});

applySettings(PRESETS.Balanced);
markPreset("Balanced");
setStatus(statusText, "Loading browser image engine...");

waitForOpenCV()
  .then(() => {
    cvReady = true;
    setStatus(
      statusText,
      "Ready. Drop an image here or click Open Image."
    );
  })
  .catch((error) => {
    cvReady = false;
    console.error(error);
    setStatus(
      statusText,
      "Could not load OpenCV.js. Check the internet connection and refresh."
    );
  });
