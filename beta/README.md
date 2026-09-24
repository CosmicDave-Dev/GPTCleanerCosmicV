# CosmicV EdgeCrunch Beta

This is the lightweight experimental branch for Ganja/Dave testing.

The beta is distributed as a **small two-file ZIP**:

- `RUN-CosmicV-Beta.bat`
- `CosmicV-EdgeCrunch-Darkroom-Beta.py`

Extract the ZIP and double-click the BAT launcher. The launcher explicitly invokes the installed Python interpreter, so it does not depend on Windows `.py` or `.pyw` file associations.

This replaces both the earlier self-extracting native EXE beta and the single `.pyw` experiment. The native EXE triggered Defender heuristics, while `.pyw` proved unreliable on machines where Windows had no Python file association.

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

- Distribution: ZIP containing one BAT launcher and one readable Python script
- Soft target: 512 KB
- Hard ceiling: 1,000,000 bytes
- CI fails packaging if the beta file exceeds the hard ceiling

The native self-extracting beta launcher and the `.pyw` distribution are retired and are no longer built.

The full standalone public release remains a separate distribution track.
