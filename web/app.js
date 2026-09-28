import { SplitViewer } from "./viewer.js";
import { saveCanvasAs } from "./export.js";
import { setStatus } from "./ui.js";

const $ = (id) => document.getElementById(id);

const fileInput = $("fileInput");
const openBtn = $("openBtn");
const clearBtn = $("clearBtn");
const fitBtn = $("fitBtn");
const oneToOneBtn = $("oneToOneBtn");
const toggleSplitBtn = $("toggleSplitBtn");
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

async function loadFile(file) {
  if (!file?.type?.startsWith("image/")) {
    setStatus(statusText, "That file does not look like an image.");
    return;
  }

  try {
    setStatus(statusText, `Loading ${file.name}...`);
    await viewer.setImageFromFile(file);
    setStatus(
      statusText,
      `Loaded: ${file.name} · wheel to zoom · drag image to pan · drag cyan divider to compare`
    );
  } catch (error) {
    console.error(error);
    setStatus(statusText, `Failed to load image: ${error.message}`);
  }
}

openBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (file) await loadFile(file);
  fileInput.value = "";
});

clearBtn.addEventListener("click", () => {
  viewer.clear();
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
    await saveCanvasAs(canvas, format, quality);
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
