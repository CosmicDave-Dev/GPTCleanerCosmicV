# CosmicV EdgeCrunch Darkroom Web

Browser-side companion to **CosmicV EdgeCrunch Darkroom V1.4**.

The shipped Windows EXE remains a separate first-class build. The web edition is its browser sidekick and does not replace it.

## Web V1.0

Implemented:

- cybercore night UI
- Quick / Cleanup / Color / Effects / Transform tabs
- widened invisible cyan-divider grab zone for easier mouse targeting
- Open Image
- browser drag-and-drop with global navigation suppression
- before/after split viewer
- draggable cyan divider
- cursor-centered mouse-wheel zoom
- pan while zoomed
- Fit and 1:1 modes
- Conservative / Balanced / Strong / Aggressive presets using the desktop V1.4 values
- bounded 1024px processing preview for fast browser interaction
- dedicated Web Worker for all heavy EdgeCrunch processing
- stale processing requests are cancelled when newer settings arrive
- pure JavaScript typed-array engine: no OpenCV.js and no external runtime download
- worker startup heartbeat with a 5-second failure timeout
- browser Darkroom controls: hue wheel, mix, brightness, contrast, saturation, warmth, exposure, gamma
- Effects controls: grayscale, sepia, invert, blur, sharpen, vignette
- Transform controls: quarter-turn rotate and horizontal/vertical flip
- advanced EdgeCrunch controls
- browser-side fragmented micro-edge detector
- structure protection
- base cleanup
- speck cleanup
- Target Mask diagnostic view
- top-bar Save / Save As workflow beside Current Version
- Save As format chooser for PNG / JPEG / WebP
- Save reuses the most recent format/target during the session
- Firefox Save As uses an explicit rename dialog, then honors Firefox's Downloads setting for destination selection; Chromium uses the native filesystem picker
- original-resolution tiled export with progress reporting
- Current Version link

The EdgeCrunch processing runs in the browser. Images are not uploaded to a CosmicV server. Web V1.0 keeps the interactive preview capped at 1024px for responsiveness, while Save PNG / JPEG / WebP reprocess the original-resolution image in overlapped background-worker tiles before applying the selected Darkroom and Transform settings.

## Local test

From your local repository:

```bat
git pull
cd web
python -m http.server 8000
```

Then open:

```text
http://localhost:8000/
```

If port 8000 is already occupied, stop the previous server with Ctrl+C first.

## Release candidate checklist

Before Web V1.0 is published:

- Firefox browser smoke test
- Chromium browser smoke test
- one human full-resolution export check on a real source image
- package the self-contained web folder as a release ZIP

## Development credit

Created at **Cosmic Dave Studios** with development assistance from **ChatGPT by OpenAI**.
