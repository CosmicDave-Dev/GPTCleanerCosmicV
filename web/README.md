# CosmicV EdgeCrunch Darkroom Web

Browser-side companion to **CosmicV EdgeCrunch Darkroom V1.4**.

The shipped Windows EXE remains a separate first-class build. The web edition is its browser sidekick and does not replace it.

## Web Preview 0.3.1

Implemented:

- cybercore night UI
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
- advanced EdgeCrunch controls
- browser-side fragmented micro-edge detector
- structure protection
- base cleanup
- speck cleanup
- Target Mask diagnostic view
- PNG / JPEG / WebP export
- Current Version link

The EdgeCrunch processing runs in the browser. Images are not uploaded to a CosmicV server. Web Preview 0.3.1 uses a self-contained JavaScript worker with a maximum 1024px-side processing preview so mouse, zoom, drag/drop, presets, and view controls remain responsive while EdgeCrunch runs. Full-resolution background export is a later web milestone.

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

## Next

After the EdgeCrunch browser port is validated against the desktop app, the next major parity pass is the Darkroom layer: brightness, contrast, saturation, warmth, exposure, gamma, hue, adjustment mix, effects, rotate/flip, and richer export presets.
