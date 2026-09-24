# GPTCleaner CosmicV

A local desktop image-cleaning tool for reducing synthetic-looking microtexture, isolated bright/dark specks, and other small artifacts often found in AI-generated images, while preserving meaningful image structure.

GPTCleaner CosmicV uses an independent processing pipeline built around luminance analysis, structural-edge detection, high-frequency texture measurement, spatial cleanup masking, Non-Local Means reconstruction, and morphological speck detection.

## Features

- Draggable original/cleaned overlay comparator
- Adjustable cleanup strength
- Patch-based cleanup control
- Texture-scale control
- Edge-protection control
- Bright/dark speck threshold
- Full-resolution output
- Local processing only
- PNG, JPEG, WebP, BMP, and TIFF input support
- PNG, JPEG, and WebP output
- High-DPI 1440p/2160p-aware Windows UI
- Fullscreen comparison mode (F11)
- Portable Windows EXE build support

## Quick start from Python

Requires Python 3.10 or newer.

```bat
python -m venv GPTCleanerCosmicV-env
GPTCleanerCosmicV-env\Scripts\activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python GPTCleanerCosmicV.py
```

No image is uploaded to a cloud service by the application. Processing occurs locally.

## Windows standalone EXE

Windows users can build a standalone executable by double-clicking:

```text
BUILD-EXE.bat
```

The builder creates an isolated build environment and produces:

```text
dist\GPTCleanerCosmicV.exe
```

The finished EXE bundles Python and the runtime dependencies, so end users do not need Python, pip, OpenCV, NumPy, or Pillow installed.

See [`docs/WINDOWS-EXE-INSTALL.txt`](docs/WINDOWS-EXE-INSTALL.txt) for end-user instructions.

## Controls

**Cleanup strength** controls the overall amount of processing.

**Patch cleanup** adjusts the Non-Local Means reconstruction strength.

**Texture window** changes the spatial scale used to identify fine texture.

**Edge protection** determines how aggressively strong image structure is protected from cleanup.

**Speck threshold** controls how strong an isolated bright or dark point must be before it is targeted.

The comparison viewer can process previews up to 3840×2160 and uses a draggable overlay divider. Saving always processes the original full-resolution image.

## How the core works

```text
RGB image
   ↓
LAB luminance/chroma separation
   ↓
structural-edge map + fine-texture map
   ↓
artifact-targeting cleanup mask
   ↓
Non-Local Means luminance candidate
   ↓
selective reconstruction
   ↓
bright/dark morphological speck cleanup
   ↓
original chroma restored
   ↓
cleaned RGB image
```

The architecture is intended to be expandable. Artifact detection and reconstruction can evolve independently, allowing additional detectors, cleanup engines, model-specific profiles, batch processing, diagnostic masks, or other image-restoration systems to be added later.

## Building the EXE

`BUILD-EXE.bat` requires Windows 10/11, 64-bit Python 3, and internet access during the build. It installs build dependencies only into `.build-env`, then packages the program with PyInstaller.

The generated EXE is unsigned, so Windows SmartScreen may warn on first launch because the binary has no established signing reputation.

## License

GPTCleaner CosmicV is released under the [MIT License](LICENSE).

Copyright © 2026 CosmicDave.
