# CosmicV EdgeCrunch Darkroom Web

Browser-side companion to **CosmicV EdgeCrunch Darkroom V1.4**.

This web edition is intentionally separate from the shipped Windows EXE. The desktop build remains untouched.

## Milestone A

Implemented:

- cybercore night UI
- Open Image
- Explorer/browser drag-and-drop
- before/after split viewer
- draggable cyan divider
- cursor-centered mouse-wheel zoom
- image pan
- Fit and 1:1 modes
- Save PNG
- Save JPEG
- Save WebP
- Current Version link

The Before and After images are intentionally identical in Milestone A. The next milestone ports the EdgeCrunch processing pipeline into `edgecrunch.js`.

## Local test

From the repository root:

```bat
cd web
python -m http.server 8000
```

Then open:

```text
http://localhost:8000/
```

All processing will remain client-side. No backend is required.
