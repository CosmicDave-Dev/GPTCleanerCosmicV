import runpy
import numpy as np

ns = runpy.run_path("beta/CosmicVEdgeCrunchBeta.py", run_name="cosmicv_beta_test")

image = np.zeros((96, 128, 3), dtype=np.uint8)
image[..., 0] = np.arange(128, dtype=np.uint8)[None, :]
image[..., 1] = 96
image[..., 2] = np.arange(96, dtype=np.uint8)[:, None]

cleanup = dict(
    edge_crunch=0.75,
    fragment_sensitivity=0.60,
    structure_protection=0.50,
    crunch_radius=1.10,
    base_cleanup=0.40,
    speck_threshold=10,
)

darkroom = dict(
    brightness=0.10,
    contrast=1.05,
    saturation=1.20,
    warmth=0.15,
    exposure=0.10,
    gamma=1.05,
    hue_degrees=12.0,
    grayscale=False,
    sepia=False,
    invert=False,
    blur_radius=0.0,
    sharpen=0.25,
    vignette=0.15,
    rotate_quadrants=1,
    flip_horizontal=True,
    flip_vertical=False,
)

out, mask, original = ns["process_rgb"](image, cleanup, darkroom)

assert out.dtype == np.uint8
assert out.shape == (128, 96, 3)
assert original.shape == out.shape
assert mask.shape == (128, 96)

neutral = dict(
    brightness=0.0,
    contrast=1.0,
    saturation=1.0,
    warmth=0.0,
    exposure=0.0,
    gamma=1.0,
    hue_degrees=0.0,
    grayscale=False,
    sepia=False,
    invert=False,
    blur_radius=0.0,
    sharpen=0.0,
    vignette=0.0,
    rotate_quadrants=0,
    flip_horizontal=False,
    flip_vertical=False,
)

out2, mask2, original2 = ns["process_rgb"](image, cleanup, neutral)
assert out2.shape == image.shape
assert original2.shape == image.shape
assert mask2.shape == image.shape[:2]

print("CosmicV beta image-pipeline smoke test passed.")
