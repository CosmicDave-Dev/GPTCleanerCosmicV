# CosmicV EdgeCrunch Darkroom

**Version V1.4**

CosmicV EdgeCrunch Darkroom is a local Windows image-cleaning and darkroom utility created at **Cosmic Dave Studios**.

> CosmicV is original software and completely free - just like you!

It combines selective AI-image artifact cleanup with fast color, effects, comparison, zoom, and export tools. Processing stays local on the user's machine.

## V1.4 highlights

- EdgeCrunch fragmented micro-edge / micro-contour cleanup
- Four curated cleanup presets: Conservative, Balanced, Strong, Aggressive
- Advanced cleanup controls with numerical type-or-paste input
- Draggable before/after comparison divider
- Target Mask diagnostic view
- Cursor-centered mouse-wheel zoom
- Right-drag panning while zoomed
- Fit and 1:1 viewer modes
- Explorer drag-and-drop
- Color Lab with hue wheel
- Brightness, contrast, saturation, warmth, exposure, gamma, and adjustment mix
- Grayscale, sepia, invert, blur, sharpen, and vignette
- Rotate and flip controls
- Save and Save As workflow
- Save As: PNG, JPEG, WebP, GIF, ICO, BMP, and TIFF
- 512 x 512 avatar export with 300 DPI metadata where supported
- Multi-resolution Windows ICO export
- High-DPI Windows interface
- F11 fullscreen mode
- Current Version link in the application header

Crop and freeform resize controls were intentionally left out of V1.4 pending a cleaner implementation.

## Current release

The current standalone Windows release is **CosmicV EdgeCrunch Darkroom V1.4**.

The application header's **Current Version** button opens the latest GitHub release:

https://github.com/CosmicDave-Dev/GPTCleanerCosmicV/releases/latest

The standalone EXE bundles Python and runtime dependencies, so end users do not need a separate Python installation.

## Run from source

Python 3.10+ is recommended.

```bat
python -m venv CosmicVEdgeCrunchDarkroom-env
CosmicVEdgeCrunchDarkroom-env\Scripts\activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python CosmicVEdgeCrunchDarkroom.py
```

## Build the standalone EXE

On Windows, double-click:

```text
BUILD-EXE.bat
```

The builder creates:

```text
dist\CosmicV-EdgeCrunch-Darkroom.exe
dist\CosmicV-EdgeCrunch-Darkroom-V1.4-Windows-x64.zip
```

See `docs/WINDOWS-EXE-INSTALL.txt` for end-user instructions.

## Web companion

The repository also contains **CosmicV EdgeCrunch Darkroom Web**, a client-side browser companion under `/web`.

The web edition is separate from the Windows V1.4 executable and does not replace it. See [`web/README.md`](web/README.md) for local testing and current web-preview status.

## Development credit

CosmicV EdgeCrunch Darkroom was created at **Cosmic Dave Studios** with development assistance from **ChatGPT by OpenAI**.

## Privacy

CosmicV EdgeCrunch Darkroom processes images locally. It does not require an account or cloud upload service to clean or edit images.

## License

CosmicV EdgeCrunch Darkroom is released under the [MIT License](LICENSE).

Copyright © 2026 CosmicDave.
