from __future__ import annotations

import ctypes
from ctypes import wintypes
import queue
import sys
import tkinter as tk
import tkinter.font as tkfont
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

try:
    import cv2
    import numpy as np
    from PIL import Image, ImageTk
except Exception as exc:
    root = tk.Tk()
    root.withdraw()
    messagebox.showerror(
        "CosmicV EdgeCrunch Beta",
        "This beta uses your installed Python environment and could not load one of its dependencies.\n\n"
        "Required: numpy, opencv-python-headless, pillow\n\n"
        f"Details: {exc}",
    )
    raise

APP_TITLE = "CosmicV EdgeCrunch Darkroom Beta"
PREVIEW_MAX_W = 3840
PREVIEW_MAX_H = 2160


def enable_high_dpi_awareness() -> None:
    if sys.platform != "win32":
        return
    for call in (
        lambda: ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)),
        lambda: ctypes.windll.shcore.SetProcessDpiAwareness(2),
        lambda: ctypes.windll.user32.SetProcessDPIAware(),
    ):
        try:
            call()
            return
        except Exception:
            pass


def robust_unit(x: np.ndarray, lo: float, hi: float) -> np.ndarray:
    x = x.astype(np.float32, copy=False)
    low, high = np.percentile(x, [lo, hi])
    if high <= low + 1e-6:
        return np.zeros_like(x, dtype=np.float32)
    return np.clip((x - low) / (high - low), 0.0, 1.0)


def smoothstep(x: np.ndarray, a: float, b: float) -> np.ndarray:
    t = np.clip((x - a) / max(b - a, 1e-6), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def clean_rgb(
    rgb: np.ndarray,
    edge_crunch: float = 0.55,
    fragment_sensitivity: float = 0.65,
    structure_protection: float = 0.90,
    crunch_radius: float = 0.80,
    base_cleanup: float = 0.15,
    speck_threshold: int = 10,
) -> tuple[np.ndarray, np.ndarray]:
    """Experimental v0.3 detector: suppress fragmented micro-edges while preserving macro structure."""
    if rgb.dtype != np.uint8 or rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ValueError("Expected an 8-bit RGB image")

    edge_crunch = float(np.clip(edge_crunch, 0.0, 1.0))
    fragment_sensitivity = float(np.clip(fragment_sensitivity, 0.0, 1.0))
    structure_protection = float(np.clip(structure_protection, 0.0, 1.0))
    crunch_radius = float(np.clip(crunch_radius, 0.35, 2.50))
    base_cleanup = float(np.clip(base_cleanup, 0.0, 1.0))
    speck_threshold = int(max(1, speck_threshold))

    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)
    lum, a, b = cv2.split(lab)
    lf = lum.astype(np.float32)

    gx = cv2.Sobel(lf, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(lf, cv2.CV_32F, 0, 1, ksize=3)
    magnitude = cv2.magnitude(gx, gy)
    grad = robust_unit(magnitude, 5.0, 99.5)

    lap = np.abs(cv2.Laplacian(lf, cv2.CV_32F, ksize=3))
    high_freq = robust_unit(lap, 10.0, 97.0)

    # Structure tensor: coherent contours score high; chaotic micro-edge fields score lower.
    sigma = 1.5
    jxx = cv2.GaussianBlur(gx * gx, (0, 0), sigma)
    jyy = cv2.GaussianBlur(gy * gy, (0, 0), sigma)
    jxy = cv2.GaussianBlur(gx * gy, (0, 0), sigma)
    coherence = np.sqrt((jxx - jyy) ** 2 + 4.0 * jxy * jxy) / (jxx + jyy + 1e-6)

    # Target medium-strength, high-frequency edges. The strongest gradients are macro structure.
    medium_edge = smoothstep(grad, 0.06, 0.38) * (1.0 - smoothstep(grad, 0.70, 0.97))
    micro_edge = smoothstep(high_freq, 0.06, 0.50) * (
        1.0 - 0.20 * smoothstep(high_freq, 0.85, 1.0)
    )

    threshold = 0.52 - 0.28 * fragment_sensitivity
    seeds = ((micro_edge > threshold) & (medium_edge > 0.12)).astype(np.float32)
    density = cv2.boxFilter(seeds, cv2.CV_32F, (7, 7), normalize=True)
    density = smoothstep(density, 0.04, 0.42)

    incoherent = np.power(
        np.clip(1.0 - coherence, 0.0, 1.0),
        0.55 + 1.65 * (1.0 - fragment_sensitivity),
    )

    mask = (
        0.64 * micro_edge * medium_edge
        + 0.36 * density * medium_edge
    ) * (0.40 + 0.60 * incoherent)

    # Coherent contours get protection proportional to the slider.
    mask *= np.clip(
        1.0 - structure_protection * 0.60 * coherence,
        0.0,
        1.0,
    )

    # Protect the highest-gradient macro contours almost absolutely.
    macro_edge = smoothstep(grad, 0.78, 0.98)
    mask *= 1.0 - macro_edge

    # Preserve the original CosmicV flat-area cleanup as a separate path.
    flat_texture = high_freq * np.power(
        1.0 - smoothstep(grad, 0.35, 0.75),
        1.4,
    )
    mask = np.maximum(mask, base_cleanup * flat_texture)
    mask = cv2.GaussianBlur(
        np.clip(mask, 0.0, 1.0),
        (0, 0),
        0.50,
    )

    candidate = cv2.GaussianBlur(lf, (0, 0), crunch_radius)
    amount = np.clip(edge_crunch * mask * 1.60, 0.0, 0.92)
    cleaned = lf * (1.0 - amount) + candidate * amount

    # Modest bright/dark fragment pass, but only where the detector already found a target.
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    opened = cv2.morphologyEx(lum, cv2.MORPH_OPEN, kernel).astype(np.float32)
    closed = cv2.morphologyEx(lum, cv2.MORPH_CLOSE, kernel).astype(np.float32)
    bright_hat = np.maximum(lf - opened, 0.0)
    dark_hat = np.maximum(closed - lf, 0.0)
    hat = np.maximum(bright_hat, dark_hat)
    hat_mask = smoothstep(
        hat,
        float(speck_threshold),
        float(max(speck_threshold + 8, speck_threshold * 2)),
    )
    hat_mask *= mask * edge_crunch * 0.22
    morph_target = np.where(dark_hat > bright_hat, closed, opened)
    cleaned = cleaned * (1.0 - hat_mask) + morph_target * hat_mask

    out_lab = cv2.merge(
        (
            np.clip(cleaned, 0, 255).astype(np.uint8),
            a,
            b,
        )
    )
    out = cv2.cvtColor(out_lab, cv2.COLOR_LAB2RGB)
    return out, mask


def apply_darkroom(
    rgb: np.ndarray,
    brightness: float = 0.0,
    contrast: float = 1.0,
    saturation: float = 1.0,
    warmth: float = 0.0,
    exposure: float = 0.0,
    gamma: float = 1.0,
    hue_degrees: float = 0.0,
    color_mix: float = 1.0,
    grayscale: bool = False,
    sepia: bool = False,
    invert: bool = False,
    blur_radius: float = 0.0,
    sharpen: float = 0.0,
    vignette: float = 0.0,
) -> np.ndarray:
    """Cheap downstream darkroom operations. Neutral defaults preserve the input."""
    source = rgb.astype(np.float32)
    x = source / 255.0

    color_mix = float(np.clip(color_mix, 0.0, 1.0))
    exposure = float(np.clip(exposure, -2.0, 2.0))
    brightness = float(np.clip(brightness, -1.0, 1.0))
    contrast = float(np.clip(contrast, 0.0, 2.0))
    saturation = float(np.clip(saturation, 0.0, 2.0))
    warmth = float(np.clip(warmth, -1.0, 1.0))
    gamma = float(np.clip(gamma, 0.40, 2.50))
    hue_degrees = float(np.clip(hue_degrees, -180.0, 180.0))
    blur_radius = float(np.clip(blur_radius, 0.0, 3.0))
    sharpen = float(np.clip(sharpen, 0.0, 2.0))
    vignette = float(np.clip(vignette, 0.0, 1.0))

    # Exposure, brightness, contrast, gamma.
    x *= 2.0 ** exposure
    x += brightness * 0.35
    x = (x - 0.5) * contrast + 0.5
    x = np.clip(x, 0.0, 1.0)
    x = np.power(x, 1.0 / gamma)

    # Warm/cool channel balance.
    if abs(warmth) > 1e-6:
        x[..., 0] += 0.18 * warmth
        x[..., 1] += 0.025 * warmth
        x[..., 2] -= 0.18 * warmth
        x = np.clip(x, 0.0, 1.0)

    # Hue and saturation are easiest and stable in HSV.
    u8 = np.clip(x * 255.0, 0, 255).astype(np.uint8)
    hsv = cv2.cvtColor(u8, cv2.COLOR_RGB2HSV).astype(np.float32)
    hsv[..., 0] = np.mod(hsv[..., 0] + hue_degrees / 2.0, 180.0)
    hsv[..., 1] = np.clip(hsv[..., 1] * saturation, 0.0, 255.0)
    u8 = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2RGB)

    if grayscale:
        gray = cv2.cvtColor(u8, cv2.COLOR_RGB2GRAY)
        u8 = cv2.cvtColor(gray, cv2.COLOR_GRAY2RGB)

    if sepia:
        f = u8.astype(np.float32)
        # Standard sepia matrix, applied in RGB order.
        r = np.clip(0.393 * f[..., 0] + 0.769 * f[..., 1] + 0.189 * f[..., 2], 0, 255)
        g = np.clip(0.349 * f[..., 0] + 0.686 * f[..., 1] + 0.168 * f[..., 2], 0, 255)
        b = np.clip(0.272 * f[..., 0] + 0.534 * f[..., 1] + 0.131 * f[..., 2], 0, 255)
        u8 = np.stack((r, g, b), axis=-1).astype(np.uint8)

    if invert:
        u8 = 255 - u8

    if blur_radius > 0.02:
        u8 = cv2.GaussianBlur(u8, (0, 0), blur_radius)

    if sharpen > 0.001:
        base = u8.astype(np.float32)
        soft = cv2.GaussianBlur(base, (0, 0), 1.0)
        u8 = np.clip(base + sharpen * (base - soft), 0, 255).astype(np.uint8)

    if vignette > 0.001:
        h, w = u8.shape[:2]
        yy = np.linspace(-1.0, 1.0, h, dtype=np.float32)[:, None]
        xx = np.linspace(-1.0, 1.0, w, dtype=np.float32)[None, :]
        radial = np.clip((xx * xx + yy * yy) / 1.45, 0.0, 1.0)
        shade = 1.0 - vignette * 0.62 * radial
        u8 = np.clip(u8.astype(np.float32) * shade[..., None], 0, 255).astype(np.uint8)

    if color_mix < 0.999:
        u8 = np.clip(
            source * (1.0 - color_mix) + u8.astype(np.float32) * color_mix,
            0,
            255,
        ).astype(np.uint8)

    return u8


def apply_transform(
    image: np.ndarray,
    rotate_quadrants: int = 0,
    flip_horizontal: bool = False,
    flip_vertical: bool = False,
) -> np.ndarray:
    """Apply lossless quarter-turn and flip operations to RGB images or masks."""
    out = image
    turns = int(rotate_quadrants) % 4
    if turns:
        out = np.rot90(out, k=-turns)
    if flip_horizontal:
        out = np.flip(out, axis=1)
    if flip_vertical:
        out = np.flip(out, axis=0)
    return np.ascontiguousarray(out)


def process_rgb(
    rgb: np.ndarray,
    cleanup_settings: dict,
    darkroom_settings: dict,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Run EdgeCrunch, darkroom adjustments, then geometry for preview/save."""
    cleaned, mask = clean_rgb(rgb, **cleanup_settings)

    options = dict(darkroom_settings)
    turns = int(options.pop("rotate_quadrants", 0))
    flip_h = bool(options.pop("flip_horizontal", False))
    flip_v = bool(options.pop("flip_vertical", False))

    cleaned = apply_darkroom(cleaned, **options)
    original_display = apply_transform(rgb, turns, flip_h, flip_v)
    cleaned = apply_transform(cleaned, turns, flip_h, flip_v)
    mask = apply_transform(mask, turns, flip_h, flip_v)
    return cleaned, mask, original_display


def read_rgb(path: str | Path) -> np.ndarray:
    data = np.fromfile(str(path), dtype=np.uint8)
    bgr = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError(f"Could not read image:\n{path}")
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)


def write_rgb(path: str | Path, rgb: np.ndarray) -> Path:
    path = Path(path)
    suffix = path.suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
        path = path.with_suffix(".png")
        suffix = ".png"

    ext = ".jpg" if suffix == ".jpeg" else suffix
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    params: list[int] = []

    if ext == ".jpg":
        params = [cv2.IMWRITE_JPEG_QUALITY, 96]
    elif ext == ".webp":
        params = [cv2.IMWRITE_WEBP_QUALITY, 96]

    ok, buf = cv2.imencode(ext, bgr, params)
    if not ok:
        raise ValueError(f"Could not encode {ext}")

    buf.tofile(str(path))
    return path


def fit_preview(rgb: np.ndarray) -> np.ndarray:
    h, w = rgb.shape[:2]
    scale = min(
        PREVIEW_MAX_W / max(w, 1),
        PREVIEW_MAX_H / max(h, 1),
        1.0,
    )
    if scale >= 0.999:
        return rgb.copy()

    return cv2.resize(
        rgb,
        (
            max(1, int(round(w * scale))),
            max(1, int(round(h * scale))),
        ),
        interpolation=cv2.INTER_AREA,
    )



BG = "#07090D"
PANEL = "#0E1219"
PANEL2 = "#151B24"
PANEL3 = "#1A2230"
TEXT = "#EAFBFF"
MUTED = "#8EA5B3"
CYAN = "#00E5FF"
CYAN2 = "#2CF7D0"
PURPLE = "#8B5CF6"
MAGENTA = "#FF3CAC"
WARNING = "#FFCA5C"
GRID = "#253142"


class OverlayViewer(tk.Frame):
    def __init__(self, parent: tk.Misc, scale: float) -> None:
        super().__init__(
            parent,
            bg=BG,
            highlightthickness=1,
            highlightbackground=GRID,
        )
        self.scale = scale
        self.split = 0.50
        self.view_mode = "fit"
        self.original: np.ndarray | None = None
        self.cleaned: np.ndarray | None = None
        self.mask: np.ndarray | None = None
        self.show_mask = False
        self.original_photo: ImageTk.PhotoImage | None = None
        self.cleaned_photo: ImageTk.PhotoImage | None = None
        self.x = self.y = self.w = self.h = 0

        self.base = tk.Label(self, bg=BG, bd=0)
        self.clip = tk.Frame(self, bg=BG, bd=0)
        self.top = tk.Label(self.clip, bg=BG, bd=0)
        self.divider = tk.Frame(
            self,
            bg=CYAN,
            cursor="sb_h_double_arrow",
        )
        self.left_tag = tk.Label(
            self,
            text="BEFORE",
            fg=TEXT,
            bg="#101820",
            font=("Segoe UI", 9, "bold"),
            padx=8,
            pady=3,
        )
        self.right_tag = tk.Label(
            self,
            text="AFTER",
            fg=TEXT,
            bg="#101820",
            font=("Segoe UI", 9, "bold"),
            padx=8,
            pady=3,
        )
        self.empty = tk.Label(
            self,
            text="DROP IMAGE HERE\nor click Open Image",
            fg=MUTED,
            bg=BG,
            font=("Segoe UI", 18, "bold"),
            justify="center",
        )
        self.empty.place(relx=0.5, rely=0.5, anchor="center")

        for widget in (
            self,
            self.base,
            self.clip,
            self.top,
            self.divider,
            self.left_tag,
            self.right_tag,
        ):
            widget.bind("<Button-1>", self._drag)
            widget.bind("<B1-Motion>", self._drag)

        self.bind("<Configure>", lambda _e: self.after_idle(self.render))

    def clear(self) -> None:
        self.original = None
        self.cleaned = None
        self.mask = None
        self.base.place_forget()
        self.clip.place_forget()
        self.divider.place_forget()
        self.left_tag.place_forget()
        self.right_tag.place_forget()
        self.empty.place(relx=0.5, rely=0.5, anchor="center")

    def set_view_mode(self, mode: str) -> None:
        self.view_mode = "1:1" if mode == "1:1" else "fit"
        self.render()

    def set_images(
        self,
        original: np.ndarray,
        cleaned: np.ndarray,
        mask: np.ndarray | None = None,
    ) -> None:
        self.original = original
        self.cleaned = cleaned
        self.mask = mask
        self.empty.place_forget()
        self.render()

    def toggle_mask(self) -> None:
        self.show_mask = not self.show_mask
        self.render()

    def render(self) -> None:
        if self.original is None or self.cleaned is None:
            return

        vw = max(1, self.winfo_width())
        vh = max(1, self.winfo_height())
        margin = max(8, int(12 * self.scale))
        ih, iw = self.original.shape[:2]

        if self.view_mode == "1:1":
            factor = 1.0
        else:
            factor = min(
                max(1, vw - 2 * margin) / max(iw, 1),
                max(1, vh - 2 * margin) / max(ih, 1),
            )

        dw = max(1, int(round(iw * factor)))
        dh = max(1, int(round(ih * factor)))

        self.x = (vw - dw) // 2
        self.y = (vh - dh) // 2
        self.w = dw
        self.h = dh

        resample = Image.Resampling.LANCZOS
        orig = Image.fromarray(self.original)
        if (dw, dh) != (iw, ih):
            orig = orig.resize((dw, dh), resample)

        clean_rgb = self.cleaned
        if self.show_mask and self.mask is not None:
            heat = np.zeros_like(clean_rgb)
            heat[..., 0] = np.clip(self.mask * 255, 0, 255).astype(np.uint8)
            heat[..., 2] = np.clip(self.mask * 120, 0, 255).astype(np.uint8)
            clean_rgb = np.clip(
                clean_rgb.astype(np.float32) * 0.50
                + heat.astype(np.float32) * 0.50,
                0,
                255,
            ).astype(np.uint8)

        clean = Image.fromarray(clean_rgb)
        if clean.size != (dw, dh):
            clean = clean.resize((dw, dh), resample)

        self.original_photo = ImageTk.PhotoImage(orig)
        self.cleaned_photo = ImageTk.PhotoImage(clean)

        self.base.configure(image=self.cleaned_photo)
        self.top.configure(image=self.original_photo)
        self.base.place(x=self.x, y=self.y, width=dw, height=dh)
        self.top.place(x=0, y=0, width=dw, height=dh)
        self._apply_split()

    def _apply_split(self) -> None:
        if self.w <= 1:
            return
        clip_w = max(1, min(self.w - 1, int(self.w * self.split)))
        line = max(2, int(2 * self.scale))
        self.clip.place(x=self.x, y=self.y, width=clip_w, height=self.h)
        self.divider.place(
            x=self.x + clip_w - line // 2,
            y=self.y,
            width=line,
            height=self.h,
        )

        pad = max(8, int(12 * self.scale))
        self.left_tag.place(x=self.x + pad, y=self.y + pad, anchor="nw")
        self.right_tag.configure(text="MASK" if self.show_mask else "AFTER")
        self.right_tag.place(
            x=self.x + self.w - pad,
            y=self.y + pad,
            anchor="ne",
        )
        self.divider.lift()
        self.left_tag.lift()
        self.right_tag.lift()

    def _drag(self, event: tk.Event) -> None:
        if self.w <= 0:
            return
        px = event.x_root - self.winfo_rootx()
        if self.x <= px <= self.x + self.w:
            self.split = float(
                np.clip((px - self.x) / self.w, 0.01, 0.99)
            )
            self._apply_split()


class HueWheel(tk.Canvas):
    def __init__(
        self,
        parent: tk.Misc,
        variable: tk.DoubleVar,
        command,
        size: int = 150,
    ) -> None:
        super().__init__(
            parent,
            width=size,
            height=size,
            bg=PANEL,
            highlightthickness=0,
            cursor="crosshair",
        )
        self.size = size
        self.variable = variable
        self.command = command
        self._photo = self._build_wheel(size)
        self.create_image(size // 2, size // 2, image=self._photo)
        self.bind("<Button-1>", self._pick)
        self.bind("<B1-Motion>", self._pick)
        self.variable.trace_add("write", lambda *_: self._draw_marker())
        self._draw_marker()

    def _build_wheel(self, size: int) -> ImageTk.PhotoImage:
        yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
        c = (size - 1) / 2.0
        dx = xx - c
        dy = c - yy
        radius = np.sqrt(dx * dx + dy * dy)
        max_r = size * 0.45

        angle = np.mod(np.degrees(np.arctan2(dy, dx)), 360.0)
        hsv = np.zeros((size, size, 3), dtype=np.uint8)
        hsv[..., 0] = np.mod(angle / 2.0, 180).astype(np.uint8)
        hsv[..., 1] = np.clip(radius / max_r * 255.0, 0, 255).astype(np.uint8)
        hsv[..., 2] = 255
        rgb = cv2.cvtColor(hsv, cv2.COLOR_HSV2RGB)

        outside = radius > max_r
        rgb[outside] = np.array([14, 18, 25], dtype=np.uint8)
        return ImageTk.PhotoImage(Image.fromarray(rgb))

    def _pick(self, event: tk.Event) -> None:
        c = (self.size - 1) / 2.0
        dx = event.x - c
        dy = c - event.y
        if dx * dx + dy * dy > (self.size * 0.48) ** 2:
            return
        deg = float(np.degrees(np.arctan2(dy, dx)))
        deg = ((deg + 180.0) % 360.0) - 180.0
        self.variable.set(deg)
        self.command()

    def _draw_marker(self) -> None:
        self.delete("marker")
        c = (self.size - 1) / 2.0
        r = self.size * 0.39
        deg = float(self.variable.get())
        rad = np.radians(deg)
        x = c + np.cos(rad) * r
        y = c - np.sin(rad) * r
        self.create_oval(
            x - 6,
            y - 6,
            x + 6,
            y + 6,
            outline=TEXT,
            width=2,
            tags="marker",
        )
        self.create_oval(
            x - 2,
            y - 2,
            x + 2,
            y + 2,
            fill=BG,
            outline="",
            tags="marker",
        )


class App(tk.Tk):
    PRESETS = {
        "Conservative": dict(edge=25, fragment=45, protect=95, radius=65, base=8, speck=8),
        "Balanced": dict(edge=55, fragment=65, protect=90, radius=80, base=15, speck=10),
        "Strong": dict(edge=75, fragment=64, protect=68, radius=105, base=52, speck=14),
        "Aggressive": dict(edge=100, fragment=53, protect=38, radius=123, base=91, speck=19),
    }

    def __init__(self) -> None:
        super().__init__()
        self.title(APP_TITLE)
        self.configure(bg=BG)
        self._configure_dpi()
        self._configure_theme()
        self.geometry(
            f"{min(self.winfo_screenwidth(), 1900)}x"
            f"{min(self.winfo_screenheight(), 1150)}"
        )
        self.minsize(1100, 720)

        self.original_full: np.ndarray | None = None
        self.original_preview: np.ndarray | None = None
        self.cleaned_preview: np.ndarray | None = None
        self.mask_preview: np.ndarray | None = None
        self.source_path: Path | None = None

        self.pool = ThreadPoolExecutor(max_workers=1)
        self.results: queue.Queue[tuple] = queue.Queue()
        self.preview_in_flight = False
        self.preview_pending = False
        self.after_id: str | None = None
        self.saving = False
        self.fullscreen = False
        self.rotate_quadrants = 0

        self._drop_hwnd = None
        self._old_wndproc = None
        self._wndproc_cb = None
        self._wndproc_type = None

        # Cleanup.
        self.edge_var = tk.DoubleVar(value=55)
        self.fragment_var = tk.DoubleVar(value=65)
        self.protect_var = tk.DoubleVar(value=90)
        self.radius_var = tk.DoubleVar(value=80)
        self.base_var = tk.DoubleVar(value=15)
        self.speck_var = tk.DoubleVar(value=10)

        # Color / darkroom.
        self.brightness_var = tk.DoubleVar(value=0)
        self.contrast_var = tk.DoubleVar(value=100)
        self.saturation_var = tk.DoubleVar(value=100)
        self.warmth_var = tk.DoubleVar(value=0)
        self.exposure_var = tk.DoubleVar(value=0)
        self.gamma_var = tk.DoubleVar(value=100)
        self.hue_var = tk.DoubleVar(value=0)
        self.color_mix_var = tk.DoubleVar(value=100)

        # Effects.
        self.gray_var = tk.BooleanVar(value=False)
        self.sepia_var = tk.BooleanVar(value=False)
        self.invert_var = tk.BooleanVar(value=False)
        self.blur_var = tk.DoubleVar(value=0)
        self.sharpen_var = tk.DoubleVar(value=0)
        self.vignette_var = tk.DoubleVar(value=0)

        # Geometry.
        self.flip_h_var = tk.BooleanVar(value=False)
        self.flip_v_var = tk.BooleanVar(value=False)
        self.transform_var = tk.StringVar(value="Rotation: 0°")
        self.view_var = tk.StringVar(value="fit")
        self.preset_name = "Balanced"
        self.preset_buttons: dict[str, tk.Button] = {}

        self._build()
        self.bind("<F11>", self._toggle_fullscreen)
        self.bind("<Escape>", self._exit_fullscreen)
        self.protocol("WM_DELETE_WINDOW", self._close)
        self.after(50, self._poll)
        self.after(700, self._enable_windows_drop)

        if sys.platform == "win32":
            self.after(0, lambda: self.state("zoomed"))

    def _configure_dpi(self) -> None:
        self.update_idletasks()
        dpi = float(self.winfo_fpixels("1i"))
        if sys.platform == "win32":
            try:
                dpi = float(
                    ctypes.windll.user32.GetDpiForWindow(self.winfo_id())
                )
            except Exception:
                pass
        self.ui_scale = max(1.0, min(3.0, dpi / 96.0))
        try:
            self.tk.call("tk", "scaling", dpi / 72.0)
        except Exception:
            pass
        for name in ("TkDefaultFont", "TkTextFont", "TkMenuFont"):
            try:
                tkfont.nametofont(name).configure(
                    family="Segoe UI",
                    size=10,
                )
            except Exception:
                pass

    def _configure_theme(self) -> None:
        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except Exception:
            pass
        style.configure(".", background=BG, foreground=TEXT)
        style.configure("TFrame", background=BG)
        style.configure("Panel.TFrame", background=PANEL)
        style.configure("TLabel", background=BG, foreground=TEXT)
        style.configure("Muted.TLabel", background=BG, foreground=MUTED)
        style.configure(
            "TButton",
            background=PANEL2,
            foreground=TEXT,
            bordercolor=GRID,
            focusthickness=1,
            focuscolor=CYAN,
            padding=(8, 6),
        )
        style.map(
            "TButton",
            background=[("active", PANEL3), ("pressed", PURPLE)],
            foreground=[("disabled", "#586875"), ("active", TEXT)],
        )
        style.configure(
            "Accent.TButton",
            background=CYAN,
            foreground="#001014",
            bordercolor=CYAN,
            font=("Segoe UI", 10, "bold"),
        )
        style.map(
            "Accent.TButton",
            background=[("active", CYAN2), ("pressed", MAGENTA)],
        )
        style.configure(
            "TNotebook",
            background=PANEL,
            borderwidth=0,
        )
        style.configure(
            "TNotebook.Tab",
            background=PANEL2,
            foreground=MUTED,
            padding=(12, 7),
        )
        style.map(
            "TNotebook.Tab",
            background=[("selected", PANEL3), ("active", "#202A38")],
            foreground=[("selected", CYAN), ("active", TEXT)],
        )
        style.configure(
            "TScale",
            background=BG,
            troughcolor=PANEL3,
            bordercolor=PANEL3,
            lightcolor=CYAN,
            darkcolor=CYAN,
        )
        style.configure(
            "TCheckbutton",
            background=BG,
            foreground=TEXT,
        )
        style.map(
            "TCheckbutton",
            background=[("active", BG)],
            foreground=[("active", CYAN)],
        )

    def _info(self, parent, title: str, text: str):
        return tk.Button(
            parent,
            text="ⓘ",
            command=lambda: messagebox.showinfo(title, text, parent=self),
            bg=BG,
            fg=CYAN,
            activebackground=PANEL3,
            activeforeground=TEXT,
            bd=0,
            relief="flat",
            font=("Segoe UI Symbol", 10, "bold"),
            cursor="hand2",
            padx=3,
            pady=0,
        )

    def _section_head(self, parent, title: str, info: str) -> None:
        row = ttk.Frame(parent)
        row.pack(fill="x", pady=(5, 6))
        ttk.Label(
            row,
            text=title,
            font=("Segoe UI", 9, "bold"),
            foreground=MUTED,
        ).pack(side="left")
        self._info(row, title, info).pack(side="left", padx=(5, 0))

    def _build(self) -> None:
        pad = max(8, int(10 * self.ui_scale))
        self.columnconfigure(1, weight=1)
        self.rowconfigure(1, weight=1)

        header = tk.Frame(self, bg=PANEL, height=48)
        header.grid(row=0, column=0, columnspan=2, sticky="ew")
        header.grid_columnconfigure(1, weight=1)

        brand = tk.Label(
            header,
            text="◈  COSMICV  //  ARTIFACT CLEANER",
            bg=PANEL,
            fg=TEXT,
            font=("Segoe UI", 11, "bold"),
            padx=14,
            pady=11,
        )
        brand.grid(row=0, column=0, sticky="w")

        toolbar = tk.Frame(header, bg=PANEL)
        toolbar.grid(row=0, column=1, sticky="e", padx=10)

        ttk.Button(
            toolbar,
            text="Open Image",
            command=self.open_image,
        ).pack(side="left", padx=3)

        ttk.Button(
            toolbar,
            text="Target Mask",
            command=self.toggle_mask,
        ).pack(side="left", padx=3)

        ttk.Button(
            toolbar,
            text="F11 Fullscreen",
            command=self._toggle_fullscreen,
        ).pack(side="left", padx=3)

        self._info(
            toolbar,
            "CosmicV Beta",
            "Drop an image anywhere in the app or use Open Image. "
            "Drag the cyan divider across the preview to compare before and after.",
        ).pack(side="left", padx=(5, 0))

        side_outer = tk.Frame(self, bg=PANEL, width=max(350, int(380 * self.ui_scale)))
        side_outer.grid(row=1, column=0, sticky="nsew")
        side_outer.grid_propagate(False)

        self.tabs = ttk.Notebook(side_outer)
        self.tabs.pack(fill="both", expand=True, padx=8, pady=8)

        quick_tab = ttk.Frame(self.tabs, padding=10)
        cleanup_tab = ttk.Frame(self.tabs, padding=10)
        color_tab = ttk.Frame(self.tabs, padding=10)
        effects_tab = ttk.Frame(self.tabs, padding=10)
        transform_tab = ttk.Frame(self.tabs, padding=10)

        self.tabs.add(quick_tab, text="Quick")
        self.tabs.add(cleanup_tab, text="Cleanup")
        self.tabs.add(color_tab, text="Color")
        self.tabs.add(effects_tab, text="Effects")
        self.tabs.add(transform_tab, text="Transform")
        self.tabs.select(quick_tab)

        viewer_frame = ttk.Frame(self, padding=(0, pad, pad, pad))
        viewer_frame.grid(row=1, column=1, sticky="nsew")
        viewer_frame.rowconfigure(1, weight=1)
        viewer_frame.columnconfigure(0, weight=1)

        self.file_var = tk.StringVar(
            value="Drop an image from Windows Explorer or click Open Image"
        )
        filebar = tk.Label(
            viewer_frame,
            textvariable=self.file_var,
            bg=BG,
            fg=MUTED,
            anchor="w",
            font=("Consolas", 9),
            pady=4,
        )
        filebar.grid(row=0, column=0, sticky="ew")

        self.viewer = OverlayViewer(viewer_frame, self.ui_scale)
        self.viewer.grid(row=1, column=0, sticky="nsew")

        # QUICK TAB
        title = ttk.Frame(quick_tab)
        title.pack(fill="x")
        ttk.Label(
            title,
            text="QUICK CLEAN",
            font=("Segoe UI", 17, "bold"),
            foreground=CYAN,
        ).pack(side="left")
        self._info(
            title,
            "Quick Clean",
            "Four curated cleanup presets. Start at Balanced, move stronger if artifacts remain, "
            "or lower if meaningful texture starts to soften.",
        ).pack(side="left", padx=5)

        ttk.Label(
            quick_tab,
            text="Sharpening · specks · scale patterns · micro-contours",
            style="Muted.TLabel",
            wraplength=320,
        ).pack(anchor="w", pady=(2, 14))

        self._section_head(
            quick_tab,
            "STRENGTH",
            "These buttons change the six advanced cleanup controls together. "
            "You can always fine-tune them on the Cleanup tab.",
        )

        preset_grid = tk.Frame(quick_tab, bg=BG)
        preset_grid.pack(fill="x")
        presets = [
            ("Conservative", "0.25"),
            ("Balanced", "0.50"),
            ("Strong", "0.75"),
            ("Aggressive", "1.00"),
        ]
        for i, (name, number) in enumerate(presets):
            b = tk.Button(
                preset_grid,
                text=f"{number}\n{name}",
                command=lambda n=name: self.apply_preset(n),
                justify="left",
                anchor="w",
                bg=PANEL2,
                fg=TEXT,
                activebackground=PANEL3,
                activeforeground=TEXT,
                bd=0,
                relief="flat",
                font=("Consolas", 10),
                padx=10,
                pady=8,
                cursor="hand2",
            )
            b.grid(
                row=i // 2,
                column=i % 2,
                sticky="nsew",
                padx=3,
                pady=3,
            )
            preset_grid.grid_columnconfigure(i % 2, weight=1)
            self.preset_buttons[name] = b
        self._update_preset_buttons()

        ttk.Label(
            quick_tab,
            text="Raise it if artifacts remain; lower it if image structure starts to feel soft.",
            style="Muted.TLabel",
            wraplength=315,
        ).pack(anchor="w", pady=(8, 14))

        self._section_head(
            quick_tab,
            "VIEW",
            "Fit shows the whole image. 1:1 displays one image pixel per screen pixel, centered in the viewer.",
        )
        viewrow = ttk.Frame(quick_tab)
        viewrow.pack(fill="x")
        ttk.Button(
            viewrow,
            text="Fit",
            command=lambda: self.set_view_mode("fit"),
        ).pack(side="left", expand=True, fill="x", padx=(0, 3))
        ttk.Button(
            viewrow,
            text="1:1",
            command=lambda: self.set_view_mode("1:1"),
        ).pack(side="left", expand=True, fill="x", padx=(3, 0))

        self._section_head(
            quick_tab,
            "OUTPUT",
            "Save Image exports the processed image. Save Comparison exports the current before/after split. "
            "Clear removes the current image from the workspace.",
        )
        self.save_btn = ttk.Button(
            quick_tab,
            text="Save Image",
            command=self.save_image,
            state="disabled",
            style="Accent.TButton",
        )
        self.save_btn.pack(fill="x", pady=(0, 6))

        outrow = ttk.Frame(quick_tab)
        outrow.pack(fill="x")
        self.compare_btn = ttk.Button(
            outrow,
            text="Save Comparison",
            command=self.save_comparison,
            state="disabled",
        )
        self.compare_btn.pack(side="left", expand=True, fill="x", padx=(0, 3))
        self.clear_btn = ttk.Button(
            outrow,
            text="Clear",
            command=self.clear_image,
            state="disabled",
        )
        self.clear_btn.pack(side="left", expand=True, fill="x", padx=(3, 0))

        ttk.Label(
            quick_tab,
            text=(
                "Strength changes how hard cleanup pushes. There is no universal best value. "
                "Among settings that look good to you, prefer the lowest."
            ),
            style="Muted.TLabel",
            wraplength=315,
            justify="left",
        ).pack(anchor="w", pady=(16, 8))

        # CLEANUP TAB
        self._slider(
            cleanup_tab, "Edge crunch", self.edge_var, 0, 100,
            "Overall strength of fragmented micro-edge suppression",
            percent=True,
            info="Controls how strongly the detector reconstructs targeted micro-contours.",
        )
        self._slider(
            cleanup_tab, "Fragment sensitivity", self.fragment_var, 0, 100,
            "Higher values admit denser/noisier micro-contours",
            percent=True,
            info="Changes how readily fragmented edge fields qualify as artifacts.",
        )
        self._slider(
            cleanup_tab, "Structure protection", self.protect_var, 0, 100,
            "Protect coherent large contours and strong real edges",
            percent=True,
            info="Higher values preserve long coherent edges such as facial outlines, text, and architecture.",
        )
        self._slider(
            cleanup_tab, "Crunch radius", self.radius_var, 35, 250,
            "Local reconstruction radius in pixels",
            divisor=100,
            info="Controls the Gaussian reconstruction radius used inside the cleanup mask.",
        )
        self._slider(
            cleanup_tab, "Base cleanup", self.base_var, 0, 100,
            "Original CosmicV flat-texture cleanup path",
            percent=True,
            info="Adds cleanup in high-frequency texture areas that are not dominated by strong structure.",
        )
        self._slider(
            cleanup_tab, "Speck threshold", self.speck_var, 2, 40,
            "Threshold for tiny bright/dark line fragments",
            info="Lower values catch subtler bright/dark specks. Higher values only touch stronger specks.",
        )
        ttk.Button(
            cleanup_tab,
            text="Reset Cleanup to Balanced",
            command=self.reset_defaults,
        ).pack(fill="x", pady=(4, 10))

        # COLOR TAB
        hue_box = tk.Frame(color_tab, bg=BG)
        hue_box.pack(fill="x", pady=(0, 8))
        hue_head = tk.Frame(hue_box, bg=BG)
        hue_head.pack(fill="x")
        tk.Label(
            hue_head,
            text="Hue wheel",
            bg=BG,
            fg=TEXT,
            font=("Segoe UI", 10, "bold"),
        ).pack(side="left")
        self._info(
            hue_head,
            "Hue wheel",
            "Click or drag around the wheel to rotate hue. The numeric Hue control below can be typed or pasted precisely.",
        ).pack(side="left", padx=5)
        self.hue_wheel = HueWheel(
            hue_box,
            self.hue_var,
            self.schedule_preview,
            size=max(130, int(145 * min(self.ui_scale, 1.5))),
        )
        self.hue_wheel.pack(anchor="center", pady=6)

        self._slider(
            color_tab, "Hue", self.hue_var, -180, 180,
            "Hue rotation in degrees",
            signed=True,
            info="Rotates colors around the hue wheel without changing geometry.",
        )
        self._slider(
            color_tab, "Adjustment mix", self.color_mix_var, 0, 100,
            "Alpha-like intensity for all Color/Effects adjustments",
            percent=True,
            info="Blends the darkroom-adjusted image back toward the cleaned image. "
                 "0% disables Color/Effects changes; 100% applies them fully. This is not file transparency.",
        )
        self._slider(
            color_tab, "Brightness", self.brightness_var, -100, 100,
            "Lift or lower overall brightness",
            signed=True,
            info="Adds or removes overall brightness after cleanup.",
        )
        self._slider(
            color_tab, "Contrast", self.contrast_var, 0, 200,
            "100 is neutral",
            percent=True,
            info="Expands or compresses tonal separation around the midpoint.",
        )
        self._slider(
            color_tab, "Saturation", self.saturation_var, 0, 200,
            "100 is neutral",
            percent=True,
            info="Controls color intensity. 0% removes chroma; values above 100% increase it.",
        )
        self._slider(
            color_tab, "Warmth", self.warmth_var, -100, 100,
            "Cooler ← 0 → warmer",
            signed=True,
            info="Moves channel balance toward blue/cool or red-gold/warm.",
        )
        self._slider(
            color_tab, "Exposure", self.exposure_var, -200, 200,
            "Exposure compensation in stops",
            divisor=100,
            signed=True,
            info="Multiplies image light by photographic stop values.",
        )
        self._slider(
            color_tab, "Gamma", self.gamma_var, 40, 250,
            "Midtone response; 1.00 is neutral",
            divisor=100,
            info="Changes midtone response while preserving the endpoints more than brightness does.",
        )
        ttk.Button(
            color_tab,
            text="Reset Color",
            command=self.reset_color,
        ).pack(fill="x", pady=(4, 10))

        # EFFECTS TAB
        for text_label, variable, help_text in (
            ("Grayscale", self.gray_var, "Converts the processed image to monochrome."),
            ("Sepia", self.sepia_var, "Applies a warm vintage sepia matrix."),
            ("Invert", self.invert_var, "Inverts RGB values for a negative effect."),
        ):
            row = tk.Frame(effects_tab, bg=BG)
            row.pack(fill="x", pady=4)
            ttk.Checkbutton(
                row,
                text=text_label,
                variable=variable,
                command=self.schedule_preview,
            ).pack(side="left")
            self._info(row, text_label, help_text).pack(side="left", padx=4)

        self._slider(
            effects_tab, "Blur", self.blur_var, 0, 300,
            "Gaussian blur radius",
            divisor=100,
            info="Softens the entire processed image after cleanup.",
        )
        self._slider(
            effects_tab, "Sharpen", self.sharpen_var, 0, 200,
            "Unsharp-mask amount",
            percent=True,
            info="Adds local contrast around edges after cleanup. Use gently to avoid reintroducing crunch.",
        )
        self._slider(
            effects_tab, "Vignette", self.vignette_var, 0, 100,
            "Darken toward the frame edges",
            percent=True,
            info="Adds a radial edge darkening effect.",
        )
        ttk.Button(
            effects_tab,
            text="Reset Effects",
            command=self.reset_effects,
        ).pack(fill="x", pady=(4, 10))

        # TRANSFORM TAB
        self._section_head(
            transform_tab,
            "GEOMETRY",
            "These transformations are lossless quarter-turns and flips applied after image processing.",
        )
        row = ttk.Frame(transform_tab)
        row.pack(fill="x", pady=4)
        ttk.Button(
            row,
            text="↶ Rotate Left",
            command=self.rotate_left,
        ).pack(side="left", expand=True, fill="x", padx=(0, 3))
        ttk.Button(
            row,
            text="Rotate Right ↷",
            command=self.rotate_right,
        ).pack(side="left", expand=True, fill="x", padx=(3, 0))

        for text_label, variable, help_text in (
            ("Flip Horizontal", self.flip_h_var, "Mirror the image left-to-right."),
            ("Flip Vertical", self.flip_v_var, "Mirror the image top-to-bottom."),
        ):
            row = tk.Frame(transform_tab, bg=BG)
            row.pack(fill="x", pady=5)
            ttk.Checkbutton(
                row,
                text=text_label,
                variable=variable,
                command=self.schedule_preview,
            ).pack(side="left")
            self._info(row, text_label, help_text).pack(side="left", padx=4)

        ttk.Label(
            transform_tab,
            textvariable=self.transform_var,
        ).pack(anchor="w", pady=(8, 4))
        ttk.Button(
            transform_tab,
            text="Reset Transform",
            command=self.reset_transform,
        ).pack(fill="x", pady=(4, 10))

        # Always-visible status under tabs.
        status_frame = tk.Frame(side_outer, bg=PANEL)
        status_frame.pack(fill="x", side="bottom")
        self.status = tk.StringVar(
            value="Ready. Drop an image here or click Open Image."
        )
        tk.Label(
            status_frame,
            textvariable=self.status,
            bg=PANEL,
            fg=MUTED,
            wraplength=340,
            justify="left",
            anchor="w",
            font=("Segoe UI", 9),
            padx=10,
            pady=8,
        ).pack(fill="x")

    def _slider(
        self,
        parent,
        title,
        var,
        low,
        high,
        help_text,
        percent=False,
        divisor=1,
        signed=False,
        info="",
    ):
        box = tk.Frame(parent, bg=BG)
        box.pack(fill="x", pady=(0, 10))

        head = tk.Frame(box, bg=BG)
        head.pack(fill="x")
        tk.Label(
            head,
            text=title,
            bg=BG,
            fg=TEXT,
            font=("Segoe UI", 10, "bold"),
        ).pack(side="left")
        self._info(head, title, info or help_text).pack(side="left", padx=4)

        entry_var = tk.StringVar()
        entry = tk.Entry(
            head,
            textvariable=entry_var,
            width=8,
            justify="right",
            bg=PANEL2,
            fg=CYAN,
            insertbackground=CYAN,
            selectbackground=PURPLE,
            selectforeground=TEXT,
            relief="flat",
            bd=0,
            font=("Consolas", 10),
        )
        entry.pack(side="right")

        def format_value(v: float) -> str:
            if divisor != 1:
                number = v / divisor
                return f"{number:+.2f}" if signed else f"{number:.2f}"
            if signed:
                return f"{int(round(v)):+d}"
            return str(int(round(v)))

        def sync_from_var(*_):
            if self.focus_get() is not entry:
                entry_var.set(format_value(float(var.get())))

        def commit(_event=None):
            raw_text = entry_var.get().strip().replace("%", "")
            try:
                display_value = float(raw_text)
            except ValueError:
                entry_var.set(format_value(float(var.get())))
                return "break"
            raw_value = display_value * divisor if divisor != 1 else display_value
            raw_value = float(np.clip(raw_value, low, high))
            var.set(raw_value)
            entry_var.set(format_value(raw_value))
            self.schedule_preview()
            return "break"

        var.trace_add("write", sync_from_var)
        sync_from_var()
        entry.bind("<Return>", commit)
        entry.bind("<KP_Enter>", commit)
        entry.bind("<FocusOut>", commit)

        ttk.Scale(
            box,
            from_=low,
            to=high,
            variable=var,
            command=lambda _v: self.schedule_preview(),
        ).pack(fill="x", pady=(5, 1))

        tk.Label(
            box,
            text=help_text,
            bg=BG,
            fg=MUTED,
            wraplength=315,
            justify="left",
            anchor="w",
            font=("Segoe UI", 8),
        ).pack(anchor="w")

    def settings(self) -> dict:
        return dict(
            edge_crunch=self.edge_var.get() / 100.0,
            fragment_sensitivity=self.fragment_var.get() / 100.0,
            structure_protection=self.protect_var.get() / 100.0,
            crunch_radius=self.radius_var.get() / 100.0,
            base_cleanup=self.base_var.get() / 100.0,
            speck_threshold=int(round(self.speck_var.get())),
        )

    def darkroom_settings(self) -> dict:
        return dict(
            brightness=self.brightness_var.get() / 100.0,
            contrast=self.contrast_var.get() / 100.0,
            saturation=self.saturation_var.get() / 100.0,
            warmth=self.warmth_var.get() / 100.0,
            exposure=self.exposure_var.get() / 100.0,
            gamma=self.gamma_var.get() / 100.0,
            hue_degrees=self.hue_var.get(),
            color_mix=self.color_mix_var.get() / 100.0,
            grayscale=self.gray_var.get(),
            sepia=self.sepia_var.get(),
            invert=self.invert_var.get(),
            blur_radius=self.blur_var.get() / 100.0,
            sharpen=self.sharpen_var.get() / 100.0,
            vignette=self.vignette_var.get() / 100.0,
            rotate_quadrants=self.rotate_quadrants,
            flip_horizontal=self.flip_h_var.get(),
            flip_vertical=self.flip_v_var.get(),
        )

    def _update_preset_buttons(self) -> None:
        for name, button in self.preset_buttons.items():
            selected = name == self.preset_name
            button.configure(
                bg=PURPLE if selected else PANEL2,
                fg=TEXT if selected else MUTED,
            )

    def apply_preset(self, name: str) -> None:
        p = self.PRESETS[name]
        self.preset_name = name
        self.edge_var.set(p["edge"])
        self.fragment_var.set(p["fragment"])
        self.protect_var.set(p["protect"])
        self.radius_var.set(p["radius"])
        self.base_var.set(p["base"])
        self.speck_var.set(p["speck"])
        self._update_preset_buttons()
        self.status.set(f"{name} cleanup preset selected.")
        self.schedule_preview()

    def reset_defaults(self) -> None:
        self.apply_preset("Balanced")

    def reset_color(self) -> None:
        self.brightness_var.set(0)
        self.contrast_var.set(100)
        self.saturation_var.set(100)
        self.warmth_var.set(0)
        self.exposure_var.set(0)
        self.gamma_var.set(100)
        self.hue_var.set(0)
        self.color_mix_var.set(100)
        self.schedule_preview()

    def reset_effects(self) -> None:
        self.gray_var.set(False)
        self.sepia_var.set(False)
        self.invert_var.set(False)
        self.blur_var.set(0)
        self.sharpen_var.set(0)
        self.vignette_var.set(0)
        self.schedule_preview()

    def rotate_left(self) -> None:
        self.rotate_quadrants = (self.rotate_quadrants - 1) % 4
        self.transform_var.set(f"Rotation: {(self.rotate_quadrants * 90) % 360}°")
        self.schedule_preview()

    def rotate_right(self) -> None:
        self.rotate_quadrants = (self.rotate_quadrants + 1) % 4
        self.transform_var.set(f"Rotation: {(self.rotate_quadrants * 90) % 360}°")
        self.schedule_preview()

    def reset_transform(self) -> None:
        self.rotate_quadrants = 0
        self.flip_h_var.set(False)
        self.flip_v_var.set(False)
        self.transform_var.set("Rotation: 0°")
        self.schedule_preview()

    def set_view_mode(self, mode: str) -> None:
        self.view_var.set(mode)
        self.viewer.set_view_mode(mode)
        self.status.set(
            "View: Fit" if mode == "fit"
            else "View: 1:1 pixel scale (centered)."
        )

    def _enable_windows_drop(self) -> None:
        if sys.platform != "win32":
            return
        try:
            hwnd = self.winfo_id()
            user32 = ctypes.windll.user32
            shell32 = ctypes.windll.shell32

            user32.GetWindowLongPtrW.restype = ctypes.c_void_p
            user32.SetWindowLongPtrW.restype = ctypes.c_void_p
            user32.CallWindowProcW.restype = ctypes.c_ssize_t

            self._drop_hwnd = hwnd
            self._old_wndproc = user32.GetWindowLongPtrW(hwnd, -4)
            self._wndproc_type = ctypes.WINFUNCTYPE(
                ctypes.c_ssize_t,
                wintypes.HWND,
                wintypes.UINT,
                wintypes.WPARAM,
                wintypes.LPARAM,
            )

            def wndproc(h, msg, wparam, lparam):
                if msg == 0x0233:  # WM_DROPFILES
                    try:
                        count = shell32.DragQueryFileW(
                            ctypes.c_void_p(wparam),
                            0xFFFFFFFF,
                            None,
                            0,
                        )
                        if count:
                            length = shell32.DragQueryFileW(
                                ctypes.c_void_p(wparam),
                                0,
                                None,
                                0,
                            )
                            buf = ctypes.create_unicode_buffer(length + 1)
                            shell32.DragQueryFileW(
                                ctypes.c_void_p(wparam),
                                0,
                                buf,
                                length + 1,
                            )
                            path = buf.value
                            self.after(0, lambda p=path: self.load_image(p))
                    finally:
                        shell32.DragFinish(ctypes.c_void_p(wparam))
                    return 0

                return user32.CallWindowProcW(
                    ctypes.c_void_p(self._old_wndproc),
                    h,
                    msg,
                    wparam,
                    lparam,
                )

            self._wndproc_cb = self._wndproc_type(wndproc)
            user32.SetWindowLongPtrW(
                hwnd,
                -4,
                ctypes.cast(self._wndproc_cb, ctypes.c_void_p),
            )
            shell32.DragAcceptFiles(hwnd, True)
            self.status.set("Ready. Drag-and-drop enabled.")
        except Exception as exc:
            self.status.set(
                f"Ready. Explorer drag/drop unavailable ({exc}); Open Image still works."
            )

    def open_image(self) -> None:
        path = filedialog.askopenfilename(
            filetypes=[
                ("Images", "*.png *.jpg *.jpeg *.webp *.bmp *.tif *.tiff"),
                ("All files", "*.*"),
            ]
        )
        if path:
            self.load_image(path)

    def load_image(self, path: str | Path) -> None:
        path = Path(path)
        if path.suffix.lower() not in {
            ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"
        }:
            messagebox.showerror(
                APP_TITLE,
                f"That file type is not supported:\n{path.suffix or '(none)'}",
            )
            return
        try:
            full = read_rgb(path)
        except Exception as exc:
            messagebox.showerror(APP_TITLE, str(exc))
            return

        self.source_path = path
        self.original_full = full
        self.original_preview = fit_preview(full)
        self.cleaned_preview = self.original_preview.copy()
        self.mask_preview = np.zeros(
            self.original_preview.shape[:2],
            dtype=np.float32,
        )

        h, w = full.shape[:2]
        ph, pw = self.original_preview.shape[:2]
        self.file_var.set(
            f"{self.source_path.name}   {w}×{h}   preview {pw}×{ph}"
        )
        self.save_btn.configure(state="normal")
        self.compare_btn.configure(state="normal")
        self.clear_btn.configure(state="normal")
        self.viewer.set_images(
            self.original_preview,
            self.cleaned_preview,
            self.mask_preview,
        )
        self.request_preview()

    def clear_image(self) -> None:
        self.original_full = None
        self.original_preview = None
        self.cleaned_preview = None
        self.mask_preview = None
        self.source_path = None
        self.file_var.set("Drop an image from Windows Explorer or click Open Image")
        self.viewer.clear()
        self.save_btn.configure(state="disabled")
        self.compare_btn.configure(state="disabled")
        self.clear_btn.configure(state="disabled")
        self.status.set("Workspace cleared.")

    def schedule_preview(self) -> None:
        if self.original_preview is None:
            return
        if self.after_id is not None:
            try:
                self.after_cancel(self.after_id)
            except Exception:
                pass
        self.after_id = self.after(220, self.request_preview)

    def request_preview(self) -> None:
        self.after_id = None
        if self.original_preview is None:
            return
        if self.preview_in_flight:
            self.preview_pending = True
            self.status.set("Settings changed. Refresh queued...")
            return

        self.preview_in_flight = True
        self.preview_pending = False
        image = self.original_preview.copy()
        settings = self.settings()
        darkroom = self.darkroom_settings()
        self.status.set("Processing preview...")

        future = self.pool.submit(process_rgb, image, settings, darkroom)

        def done(f):
            try:
                out, mask, original_display = f.result()
                err = None
            except Exception as exc:
                out = None
                mask = None
                original_display = None
                err = exc
            self.results.put(
                ("preview", out, mask, original_display, err)
            )

        future.add_done_callback(done)

    def toggle_mask(self) -> None:
        self.viewer.toggle_mask()

    def save_image(self) -> None:
        if self.original_full is None or self.saving:
            return
        stem = self.source_path.stem if self.source_path else "image"
        path = filedialog.asksaveasfilename(
            defaultextension=".png",
            initialfile=f"{stem}_cosmicv.png",
            filetypes=[
                ("PNG", "*.png"),
                ("JPEG", "*.jpg *.jpeg"),
                ("WebP", "*.webp"),
            ],
        )
        if not path:
            return

        self.saving = True
        self.save_btn.configure(state="disabled")
        self.status.set("Processing full-resolution image...")
        image = self.original_full.copy()
        settings = self.settings()
        darkroom = self.darkroom_settings()

        future = self.pool.submit(process_rgb, image, settings, darkroom)

        def done(f):
            try:
                out, _mask, _original_display = f.result()
                saved = write_rgb(path, out)
                err = None
            except Exception as exc:
                saved = None
                err = exc
            self.results.put(("save", saved, err))

        future.add_done_callback(done)

    def save_comparison(self) -> None:
        if self.original_full is None or self.saving:
            return
        stem = self.source_path.stem if self.source_path else "image"
        path = filedialog.asksaveasfilename(
            defaultextension=".png",
            initialfile=f"{stem}_comparison.png",
            filetypes=[("PNG", "*.png"), ("JPEG", "*.jpg *.jpeg")],
        )
        if not path:
            return

        self.saving = True
        self.compare_btn.configure(state="disabled")
        self.status.set("Rendering full-resolution comparison...")
        image = self.original_full.copy()
        settings = self.settings()
        darkroom = self.darkroom_settings()
        split = float(self.viewer.split)

        def job():
            out, _mask, original_display = process_rgb(
                image,
                settings,
                darkroom,
            )
            h, w = out.shape[:2]
            cut = max(1, min(w - 1, int(round(w * split))))
            comp = out.copy()
            comp[:, :cut] = original_display[:, :cut]
            thickness = max(2, int(round(w / 900)))
            comp[:, max(0, cut - thickness):min(w, cut + thickness)] = np.array(
                [0, 229, 255],
                dtype=np.uint8,
            )
            return write_rgb(path, comp)

        future = self.pool.submit(job)

        def done(f):
            try:
                saved = f.result()
                err = None
            except Exception as exc:
                saved = None
                err = exc
            self.results.put(("save_compare", saved, err))

        future.add_done_callback(done)

    def _poll(self) -> None:
        try:
            while True:
                msg = self.results.get_nowait()

                if msg[0] == "preview":
                    _, out, mask, original_display, err = msg
                    self.preview_in_flight = False
                    if err:
                        self.status.set("Preview failed.")
                        messagebox.showerror(APP_TITLE, str(err))
                    else:
                        self.cleaned_preview = out
                        self.mask_preview = mask
                        if original_display is not None:
                            self.viewer.set_images(
                                original_display,
                                out,
                                mask,
                            )
                        self.status.set(
                            "Preview ready. Drag the cyan divider to compare."
                        )
                    if self.preview_pending:
                        self.preview_pending = False
                        self.after_idle(self.request_preview)

                elif msg[0] == "save":
                    _, saved, err = msg
                    self.saving = False
                    self.save_btn.configure(state="normal")
                    if err:
                        self.status.set("Save failed.")
                        messagebox.showerror(APP_TITLE, str(err))
                    else:
                        self.status.set(f"Saved: {Path(saved).name}")

                elif msg[0] == "save_compare":
                    _, saved, err = msg
                    self.saving = False
                    self.compare_btn.configure(state="normal")
                    if err:
                        self.status.set("Comparison save failed.")
                        messagebox.showerror(APP_TITLE, str(err))
                    else:
                        self.status.set(
                            f"Comparison saved: {Path(saved).name}"
                        )

        except queue.Empty:
            pass

        if self.winfo_exists():
            self.after(50, self._poll)

    def _toggle_fullscreen(self, _event=None):
        self.fullscreen = not self.fullscreen
        self.attributes("-fullscreen", self.fullscreen)
        return "break"

    def _exit_fullscreen(self, _event=None):
        if self.fullscreen:
            self.fullscreen = False
            self.attributes("-fullscreen", False)
        return "break"

    def _restore_drop_hook(self) -> None:
        if (
            sys.platform == "win32"
            and self._drop_hwnd
            and self._old_wndproc
        ):
            try:
                ctypes.windll.shell32.DragAcceptFiles(
                    self._drop_hwnd,
                    False,
                )
                ctypes.windll.user32.SetWindowLongPtrW(
                    self._drop_hwnd,
                    -4,
                    ctypes.c_void_p(self._old_wndproc),
                )
            except Exception:
                pass

    def _close(self) -> None:
        self._restore_drop_hook()
        self.pool.shutdown(wait=False, cancel_futures=True)
        self.destroy()

def main() -> None:
    enable_high_dpi_awareness()
    App().mainloop()


if __name__ == "__main__":
    main()
