# CosmicV EdgeCrunch Beta

This is the lightweight experimental branch for Ganja/Dave testing.

The beta intentionally **does not bundle Python, NumPy, OpenCV, or Pillow**. The tiny launcher EXE embeds only the beta Python application, extracts it to the current user's Local AppData folder, then starts it with the installed Python environment.

## What is new

- Fragmented micro-edge / micro-contour detector
- Local structure-tensor coherence analysis
- Strong macro-edge protection
- Adjustable reconstruction radius
- Original CosmicV flat-texture cleanup retained as a separate path
- Tiny bright/dark fragment cleanup only inside the detector mask
- Draggable original/cleaned overlay
- **Target Mask** diagnostic view
- High-DPI 1440p/2160p-aware UI
- Preview processing up to 3840×2160
- F11 fullscreen comparison

## Default beta controls

- Edge crunch: 55%
- Fragment sensitivity: 65%
- Structure protection: 90%
- Crunch radius: 0.80 px
- Base cleanup: 15%
- Speck threshold: 10

## Requirements

The machine must already have Python 3 plus:

```text
numpy
opencv-python-headless
pillow
```

This requirement is deliberate for rapid beta iteration. The normal public release remains the self-contained standalone build.
