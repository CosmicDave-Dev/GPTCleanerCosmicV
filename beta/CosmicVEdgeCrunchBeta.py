from __future__ import annotations

import ctypes
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
    grayscale: bool = False,
    sepia: bool = False,
    invert: bool = False,
    blur_radius: float = 0.0,
    sharpen: float = 0.0,
    vignette: float = 0.0,
) -> np.ndarray:
    """Cheap downstream darkroom operations. Neutral defaults preserve the input."""
    x = rgb.astype(np.float32) / 255.0

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


class OverlayViewer(tk.Frame):
    def __init__(self, parent: tk.Misc, scale: float) -> None:
        super().__init__(parent, bg="#101214", highlightthickness=0)
        self.scale = scale
        self.split = 0.50
        self.original: np.ndarray | None = None
        self.cleaned: np.ndarray | None = None
        self.mask: np.ndarray | None = None
        self.show_mask = False
        self.original_photo: ImageTk.PhotoImage | None = None
        self.cleaned_photo: ImageTk.PhotoImage | None = None
        self.x = self.y = self.w = self.h = 0

        self.base = tk.Label(self, bg="#101214", bd=0)
        self.clip = tk.Frame(self, bg="#101214", bd=0)
        self.top = tk.Label(self.clip, bg="#101214", bd=0)
        self.divider = tk.Frame(
            self,
            bg="#f2c14e",
            cursor="sb_h_double_arrow",
        )
        self.left_tag = tk.Label(
            self,
            text="ORIGINAL",
            fg="white",
            bg="#17191c",
            font=("Segoe UI", 10, "bold"),
            padx=8,
            pady=4,
        )
        self.right_tag = tk.Label(
            self,
            text="CLEANED",
            fg="white",
            bg="#17191c",
            font=("Segoe UI", 10, "bold"),
            padx=8,
            pady=4,
        )
        self.empty = tk.Label(
            self,
            text="Open an image",
            fg="#aab0b7",
            bg="#101214",
            font=("Segoe UI", 18),
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

        self.bind(
            "<Configure>",
            lambda _e: self.after_idle(self.render),
        )

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
        factor = min(
            (vw - 2 * margin) / iw,
            (vh - 2 * margin) / ih,
        )
        dw = max(1, int(iw * factor))
        dh = max(1, int(ih * factor))

        self.x = (vw - dw) // 2
        self.y = (vh - dh) // 2
        self.w = dw
        self.h = dh

        orig = Image.fromarray(self.original).resize(
            (dw, dh),
            Image.Resampling.LANCZOS,
        )

        clean_rgb = self.cleaned
        if self.show_mask and self.mask is not None:
            heat = np.zeros_like(clean_rgb)
            heat[..., 0] = np.clip(
                self.mask * 255,
                0,
                255,
            ).astype(np.uint8)
            clean_rgb = np.clip(
                clean_rgb.astype(np.float32) * 0.55
                + heat.astype(np.float32) * 0.45,
                0,
                255,
            ).astype(np.uint8)

        clean = Image.fromarray(clean_rgb).resize(
            (dw, dh),
            Image.Resampling.LANCZOS,
        )

        self.original_photo = ImageTk.PhotoImage(orig)
        self.cleaned_photo = ImageTk.PhotoImage(clean)

        self.base.configure(image=self.cleaned_photo)
        self.top.configure(image=self.original_photo)
        self.base.place(
            x=self.x,
            y=self.y,
            width=dw,
            height=dh,
        )
        self.top.place(
            x=0,
            y=0,
            width=dw,
            height=dh,
        )
        self._apply_split()

    def _apply_split(self) -> None:
        if self.w <= 1:
            return

        clip_w = max(
            1,
            min(self.w - 1, int(self.w * self.split)),
        )
        line = max(3, int(3 * self.scale))
        self.clip.place(
            x=self.x,
            y=self.y,
            width=clip_w,
            height=self.h,
        )
        self.divider.place(
            x=self.x + clip_w - line // 2,
            y=self.y,
            width=line,
            height=self.h,
        )

        pad = max(8, int(12 * self.scale))
        self.left_tag.place(
            x=self.x + pad,
            y=self.y + pad,
            anchor="nw",
        )
        self.right_tag.configure(
            text="MASK" if self.show_mask else "CLEANED"
        )
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
                np.clip(
                    (px - self.x) / self.w,
                    0.01,
                    0.99,
                )
            )
            self._apply_split()


class App(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title(APP_TITLE)
        self._configure_dpi()
        self.geometry(
            f"{min(self.winfo_screenwidth(), 1800)}x"
            f"{min(self.winfo_screenheight(), 1100)}"
        )
        self.minsize(1050, 700)

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

        self._build()
        self.bind("<F11>", self._toggle_fullscreen)
        self.bind("<Escape>", self._exit_fullscreen)
        self.protocol("WM_DELETE_WINDOW", self._close)
        self.after(50, self._poll)

        if sys.platform == "win32":
            self.after(0, lambda: self.state("zoomed"))

    def _configure_dpi(self) -> None:
        self.update_idletasks()
        dpi = float(self.winfo_fpixels("1i"))

        if sys.platform == "win32":
            try:
                dpi = float(
                    ctypes.windll.user32.GetDpiForWindow(
                        self.winfo_id()
                    )
                )
            except Exception:
                pass

        self.ui_scale = max(
            1.0,
            min(3.0, dpi / 96.0),
        )

        try:
            self.tk.call(
                "tk",
                "scaling",
                dpi / 72.0,
            )
        except Exception:
            pass

        for name in (
            "TkDefaultFont",
            "TkTextFont",
            "TkMenuFont",
        ):
            try:
                tkfont.nametofont(name).configure(
                    family="Segoe UI",
                    size=11,
                )
            except Exception:
                pass

    def _build(self) -> None:
        pad = max(8, int(10 * self.ui_scale))
        self.columnconfigure(1, weight=1)
        self.rowconfigure(1, weight=1)

        bar = ttk.Frame(self, padding=pad)
        bar.grid(
            row=0,
            column=0,
            columnspan=2,
            sticky="ew",
        )

        ttk.Button(
            bar,
            text="Open Image",
            command=self.open_image,
        ).pack(side="left")

        self.save_btn = ttk.Button(
            bar,
            text="Save As...",
            command=self.save_image,
            state="disabled",
        )
        self.save_btn.pack(
            side="left",
            padx=6,
        )

        ttk.Button(
            bar,
            text="Target Mask",
            command=self.toggle_mask,
        ).pack(
            side="left",
            padx=6,
        )

        ttk.Button(
            bar,
            text="F11 Fullscreen",
            command=self._toggle_fullscreen,
        ).pack(
            side="left",
            padx=6,
        )

        self.file_var = tk.StringVar(
            value="CosmicV EdgeCrunch Beta"
        )
        ttk.Label(
            bar,
            textvariable=self.file_var,
        ).pack(
            side="left",
            padx=12,
        )

        side = ttk.Frame(
            self,
            padding=pad,
            width=max(330, int(360 * self.ui_scale)),
        )
        side.grid(
            row=1,
            column=0,
            sticky="nsew",
        )
        side.grid_propagate(False)

        viewer_frame = ttk.Frame(
            self,
            padding=(0, pad, pad, pad),
        )
        viewer_frame.grid(
            row=1,
            column=1,
            sticky="nsew",
        )
        viewer_frame.rowconfigure(
            0,
            weight=1,
        )
        viewer_frame.columnconfigure(
            0,
            weight=1,
        )

        self.viewer = OverlayViewer(
            viewer_frame,
            self.ui_scale,
        )
        self.viewer.grid(
            row=0,
            column=0,
            sticky="nsew",
        )

        ttk.Label(
            side,
            text="CosmicV Darkroom",
            font=("Segoe UI", 18, "bold"),
        ).pack(anchor="w")

        ttk.Label(
            side,
            text=(
                "EdgeCrunch + lightweight darkroom tools. "
                "Drag the gold divider to compare."
            ),
            wraplength=310,
            justify="left",
        ).pack(
            anchor="w",
            pady=(4, 10),
        )

        tabs = ttk.Notebook(side)
        tabs.pack(fill="both", expand=True)

        cleanup_tab = ttk.Frame(tabs, padding=6)
        color_tab = ttk.Frame(tabs, padding=6)
        effects_tab = ttk.Frame(tabs, padding=6)
        transform_tab = ttk.Frame(tabs, padding=6)
        tabs.add(cleanup_tab, text="Cleanup")
        tabs.add(color_tab, text="Color")
        tabs.add(effects_tab, text="Effects")
        tabs.add(transform_tab, text="Transform")

        self.edge_var = tk.DoubleVar(value=55)
        self.fragment_var = tk.DoubleVar(value=65)
        self.protect_var = tk.DoubleVar(value=90)
        self.radius_var = tk.DoubleVar(value=80)
        self.base_var = tk.DoubleVar(value=15)
        self.speck_var = tk.DoubleVar(value=10)

        self._slider(
            cleanup_tab,
            "Edge crunch",
            self.edge_var,
            0,
            100,
            "Overall strength of fragmented micro-edge suppression",
            percent=True,
        )
        self._slider(
            cleanup_tab,
            "Fragment sensitivity",
            self.fragment_var,
            0,
            100,
            "Higher values target denser, noisier micro-contours",
            percent=True,
        )
        self._slider(
            cleanup_tab,
            "Structure protection",
            self.protect_var,
            0,
            100,
            "Protect coherent large contours and strong real edges",
            percent=True,
        )
        self._slider(
            cleanup_tab,
            "Crunch radius",
            self.radius_var,
            35,
            250,
            "Local reconstruction radius (0.35 to 2.50 px)",
            divisor=100,
        )
        self._slider(
            cleanup_tab,
            "Base cleanup",
            self.base_var,
            0,
            100,
            "Original CosmicV flat-texture cleanup path",
            percent=True,
        )
        self._slider(
            cleanup_tab,
            "Speck threshold",
            self.speck_var,
            2,
            40,
            "Threshold for tiny bright/dark line fragments",
        )
        ttk.Button(
            cleanup_tab,
            text="Reset Cleanup",
            command=self.reset_defaults,
        ).pack(fill="x", pady=(4, 10))

        self.brightness_var = tk.DoubleVar(value=0)
        self.contrast_var = tk.DoubleVar(value=100)
        self.saturation_var = tk.DoubleVar(value=100)
        self.warmth_var = tk.DoubleVar(value=0)
        self.exposure_var = tk.DoubleVar(value=0)
        self.gamma_var = tk.DoubleVar(value=100)
        self.hue_var = tk.DoubleVar(value=0)

        self._slider(
            color_tab, "Brightness", self.brightness_var, -100, 100,
            "Lift or lower overall brightness", signed=True,
        )
        self._slider(
            color_tab, "Contrast", self.contrast_var, 0, 200,
            "100 is neutral", percent=True,
        )
        self._slider(
            color_tab, "Saturation", self.saturation_var, 0, 200,
            "100 is neutral", percent=True,
        )
        self._slider(
            color_tab, "Warmth", self.warmth_var, -100, 100,
            "Cooler ← 0 → warmer", signed=True,
        )
        self._slider(
            color_tab, "Exposure", self.exposure_var, -200, 200,
            "Exposure compensation in stops", divisor=100, signed=True,
        )
        self._slider(
            color_tab, "Gamma", self.gamma_var, 40, 250,
            "Midtone response; 1.00 is neutral", divisor=100,
        )
        self._slider(
            color_tab, "Hue", self.hue_var, -180, 180,
            "Hue rotation in degrees", signed=True,
        )
        ttk.Button(
            color_tab,
            text="Reset Color",
            command=self.reset_color,
        ).pack(fill="x", pady=(4, 10))

        self.gray_var = tk.BooleanVar(value=False)
        self.sepia_var = tk.BooleanVar(value=False)
        self.invert_var = tk.BooleanVar(value=False)
        self.blur_var = tk.DoubleVar(value=0)
        self.sharpen_var = tk.DoubleVar(value=0)
        self.vignette_var = tk.DoubleVar(value=0)

        for text_label, variable in (
            ("Grayscale", self.gray_var),
            ("Sepia", self.sepia_var),
            ("Invert", self.invert_var),
        ):
            ttk.Checkbutton(
                effects_tab,
                text=text_label,
                variable=variable,
                command=self.schedule_preview,
            ).pack(anchor="w", pady=4)

        self._slider(
            effects_tab, "Blur", self.blur_var, 0, 300,
            "Gaussian blur radius (0.00 to 3.00 px)", divisor=100,
        )
        self._slider(
            effects_tab, "Sharpen", self.sharpen_var, 0, 200,
            "Unsharp-mask amount", percent=True,
        )
        self._slider(
            effects_tab, "Vignette", self.vignette_var, 0, 100,
            "Darken toward the frame edges", percent=True,
        )
        ttk.Button(
            effects_tab,
            text="Reset Effects",
            command=self.reset_effects,
        ).pack(fill="x", pady=(4, 10))

        ttk.Label(
            transform_tab,
            text="Lossless quarter-turns and flips",
            wraplength=300,
        ).pack(anchor="w", pady=(0, 10))

        row = ttk.Frame(transform_tab)
        row.pack(fill="x", pady=4)
        ttk.Button(row, text="↶ Rotate Left", command=self.rotate_left).pack(
            side="left", expand=True, fill="x", padx=(0, 3)
        )
        ttk.Button(row, text="Rotate Right ↷", command=self.rotate_right).pack(
            side="left", expand=True, fill="x", padx=(3, 0)
        )

        self.flip_h_var = tk.BooleanVar(value=False)
        self.flip_v_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(
            transform_tab,
            text="Flip Horizontal",
            variable=self.flip_h_var,
            command=self.schedule_preview,
        ).pack(anchor="w", pady=5)
        ttk.Checkbutton(
            transform_tab,
            text="Flip Vertical",
            variable=self.flip_v_var,
            command=self.schedule_preview,
        ).pack(anchor="w", pady=5)
        self.transform_var = tk.StringVar(value="Rotation: 0°")
        ttk.Label(
            transform_tab,
            textvariable=self.transform_var,
        ).pack(anchor="w", pady=(8, 4))
        ttk.Button(
            transform_tab,
            text="Reset Transform",
            command=self.reset_transform,
        ).pack(fill="x", pady=(4, 10))

        self.status = tk.StringVar(
            value="Open one of Ganja's problem images."
        )
        ttk.Label(
            side,
            textvariable=self.status,
            wraplength=310,
            justify="left",
        ).pack(
            anchor="w",
            pady=(8, 0),
        )

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
    ):
        box = ttk.Frame(parent)
        box.pack(
            fill="x",
            pady=(0, 11),
        )

        head = ttk.Frame(box)
        head.pack(fill="x")

        ttk.Label(
            head,
            text=title,
            font=("Segoe UI", 10, "bold"),
        ).pack(side="left")

        value = ttk.Label(
            head,
            width=8,
            anchor="e",
        )
        value.pack(side="right")

        def update(*_):
            v = var.get()
            if percent:
                value.configure(
                    text=f"{int(round(v))}%"
                )
            elif divisor != 1:
                number = v / divisor
                value.configure(
                    text=f"{number:+.2f}" if signed else f"{number:.2f}"
                )
            elif signed:
                value.configure(
                    text=f"{int(round(v)):+d}"
                )
            else:
                value.configure(
                    text=str(int(round(v)))
                )

        var.trace_add("write", update)
        update()

        ttk.Scale(
            box,
            from_=low,
            to=high,
            variable=var,
            command=lambda _v: self.schedule_preview(),
        ).pack(
            fill="x",
            pady=(3, 1),
        )

        ttk.Label(
            box,
            text=help_text,
            wraplength=310,
        ).pack(anchor="w")

    def settings(self) -> dict:
        return dict(
            edge_crunch=self.edge_var.get() / 100.0,
            fragment_sensitivity=self.fragment_var.get() / 100.0,
            structure_protection=self.protect_var.get() / 100.0,
            crunch_radius=self.radius_var.get() / 100.0,
            base_cleanup=self.base_var.get() / 100.0,
            speck_threshold=int(
                round(self.speck_var.get())
            ),
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

    def reset_defaults(self) -> None:
        self.edge_var.set(55)
        self.fragment_var.set(65)
        self.protect_var.set(90)
        self.radius_var.set(80)
        self.base_var.set(15)
        self.speck_var.set(10)
        self.schedule_preview()

    def reset_color(self) -> None:
        self.brightness_var.set(0)
        self.contrast_var.set(100)
        self.saturation_var.set(100)
        self.warmth_var.set(0)
        self.exposure_var.set(0)
        self.gamma_var.set(100)
        self.hue_var.set(0)
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
        self.transform_var.set(f"Rotation: {self.rotate_quadrants * 90}°")
        self.schedule_preview()

    def rotate_right(self) -> None:
        self.rotate_quadrants = (self.rotate_quadrants + 1) % 4
        self.transform_var.set(f"Rotation: {self.rotate_quadrants * 90}°")
        self.schedule_preview()

    def reset_transform(self) -> None:
        self.rotate_quadrants = 0
        self.flip_h_var.set(False)
        self.flip_v_var.set(False)
        self.transform_var.set("Rotation: 0°")
        self.schedule_preview()

    def open_image(self) -> None:
        path = filedialog.askopenfilename(
            filetypes=[
                (
                    "Images",
                    "*.png *.jpg *.jpeg *.webp *.bmp *.tif *.tiff",
                ),
                (
                    "All files",
                    "*.*",
                ),
            ]
        )
        if not path:
            return

        try:
            full = read_rgb(path)
        except Exception as exc:
            messagebox.showerror(
                APP_TITLE,
                str(exc),
            )
            return

        self.source_path = Path(path)
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
            f"{self.source_path.name}   "
            f"{w}×{h}   "
            f"preview {pw}×{ph}"
        )
        self.save_btn.configure(
            state="normal"
        )
        self.viewer.set_images(
            self.original_preview,
            self.cleaned_preview,
            self.mask_preview,
        )
        self.request_preview()

    def schedule_preview(self) -> None:
        if self.original_preview is None:
            return

        if self.after_id is not None:
            try:
                self.after_cancel(
                    self.after_id
                )
            except Exception:
                pass

        self.after_id = self.after(
            250,
            self.request_preview,
        )

    def request_preview(self) -> None:
        self.after_id = None

        if self.original_preview is None:
            return

        if self.preview_in_flight:
            self.preview_pending = True
            self.status.set(
                "Settings changed. Refresh queued..."
            )
            return

        self.preview_in_flight = True
        self.preview_pending = False

        image = self.original_preview.copy()
        settings = self.settings()
        darkroom = self.darkroom_settings()

        self.status.set(
            "Processing preview..."
        )

        future = self.pool.submit(
            process_rgb,
            image,
            settings,
            darkroom,
        )

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
                (
                    "preview",
                    out,
                    mask,
                    original_display,
                    err,
                )
            )

        future.add_done_callback(done)

    def toggle_mask(self) -> None:
        self.viewer.toggle_mask()

    def save_image(self) -> None:
        if self.original_full is None or self.saving:
            return

        stem = (
            self.source_path.stem
            if self.source_path
            else "image"
        )

        path = filedialog.asksaveasfilename(
            defaultextension=".png",
            initialfile=f"{stem}_edgecrunch.png",
            filetypes=[
                ("PNG", "*.png"),
                ("JPEG", "*.jpg *.jpeg"),
                ("WebP", "*.webp"),
            ],
        )
        if not path:
            return

        self.saving = True
        self.save_btn.configure(
            state="disabled"
        )
        self.status.set(
            "Processing full-resolution image..."
        )

        image = self.original_full.copy()
        settings = self.settings()
        darkroom = self.darkroom_settings()

        future = self.pool.submit(
            process_rgb,
            image,
            settings,
            darkroom,
        )

        def done(f):
            try:
                out, _mask, _original_display = f.result()
                saved = write_rgb(
                    path,
                    out,
                )
                err = None
            except Exception as exc:
                saved = None
                err = exc

            self.results.put(
                (
                    "save",
                    saved,
                    err,
                )
            )

        future.add_done_callback(done)

    def _poll(self) -> None:
        try:
            while True:
                msg = self.results.get_nowait()

                if msg[0] == "preview":
                    _, out, mask, original_display, err = msg
                    self.preview_in_flight = False

                    if err:
                        self.status.set(
                            "Preview failed."
                        )
                        messagebox.showerror(
                            APP_TITLE,
                            str(err),
                        )
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
                            "Preview ready. Drag the divider. "
                            "Target Mask shows what the detector is touching."
                        )

                    if self.preview_pending:
                        self.preview_pending = False
                        self.after_idle(
                            self.request_preview
                        )

                elif msg[0] == "save":
                    _, saved, err = msg
                    self.saving = False
                    self.save_btn.configure(
                        state="normal"
                    )

                    if err:
                        self.status.set(
                            "Save failed."
                        )
                        messagebox.showerror(
                            APP_TITLE,
                            str(err),
                        )
                    else:
                        self.status.set(
                            f"Saved: {Path(saved).name}"
                        )

        except queue.Empty:
            pass

        if self.winfo_exists():
            self.after(
                50,
                self._poll,
            )

    def _toggle_fullscreen(
        self,
        _event=None,
    ):
        self.fullscreen = not self.fullscreen
        self.attributes(
            "-fullscreen",
            self.fullscreen,
        )
        return "break"

    def _exit_fullscreen(
        self,
        _event=None,
    ):
        if self.fullscreen:
            self.fullscreen = False
            self.attributes(
                "-fullscreen",
                False,
            )
        return "break"

    def _close(self) -> None:
        self.pool.shutdown(
            wait=False,
            cancel_futures=True,
        )
        self.destroy()


def main() -> None:
    enable_high_dpi_awareness()
    App().mainloop()


if __name__ == "__main__":
    main()
