# CosmicV EdgeCrunch Beta

This is the lightweight experimental branch for Ganja/Dave testing.

The beta is now distributed as a **single readable .pyw file**. It does not bundle Python, NumPy, OpenCV, or Pillow, and it does not use a self-extracting native launcher.

Double-clicking the .pyw file launches the GUI through the tester's installed Python environment. A ZIP may be used for chat/Discord transport.

This replaces the earlier thin native EXE beta, which was retired after Microsoft Defender heuristics flagged its embedded-script/extract-and-launch behavior.

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
- Brightness, contrast, saturation, warmth, exposure, gamma, and hue
- Grayscale, sepia, invert, blur, sharpen, and vignette
- 90° rotate and horizontal/vertical flip
- Tabbed Cleanup / Color / Effects / Transform controls
- Thin-build size budget: 512 KB target, 1 MB hard ceiling

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


## Beta size policy

The beta is deliberately kept small because it relies on the tester's already-installed Python/OpenCV/NumPy/Pillow environment.

- Distribution: single `.pyw` file, optionally transported inside ZIP
- Soft target: 512 KB
- Hard ceiling: 1,000,000 bytes
- CI fails packaging if the beta file exceeds the hard ceiling

The native self-extracting beta launcher is retired and is no longer built.

The full standalone public release remains a separate distribution track.
