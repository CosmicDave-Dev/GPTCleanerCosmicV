from __future__ import annotations

import ctypes
import queue
import sys
import tkinter as tk
import tkinter.font as tkfont
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import cv2
import numpy as np
from PIL import Image, ImageTk


APP_TITLE = "GPTCleaner CosmicV"
PREVIEW_MAX_W = 3840
PREVIEW_MAX_H = 2160
OVERLAY_START = 0.50


def enable_high_dpi_awareness() -> None:
    """Request native per-monitor DPI rendering on modern Windows."""
    if sys.platform != "win32":
        return

    try:
        # PER_MONITOR_AWARE_V2. Best option on current Windows 10/11.
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        return
    except Exception:
        pass

    try:
        # PROCESS_PER_MONITOR_DPI_AWARE.
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
        return
    except Exception:
        pass

    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


def _robust_unit(
    x: np.ndarray,
    lo: float = 10.0,
    hi: float = 90.0,
) -> np.ndarray:
    """Normalize an array to 0..1 using robust percentiles."""
    x = x.astype(np.float32, copy=False)
    low, high = np.percentile(x, [lo, hi])

    if high <= low + 1e-6:
        return np.zeros_like(x, dtype=np.float32)

    return np.clip((x - low) / (high - low), 0.0, 1.0)


def clean_rgb(
    rgb: np.ndarray,
    strength: float = 0.65,
    nlm_h: float = 8.0,
    texture_window: int = 9,
    protect_edges: float = 0.80,
    speck_threshold: int = 10,
) -> np.ndarray:
    """Clean fine synthetic-looking microtexture while protecting meaningful edges."""
    if rgb.dtype != np.uint8 or rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ValueError("rgb must be a uint8 array shaped (H, W, 3)")

    strength = float(np.clip(strength, 0.0, 1.0))
    protect_edges = float(np.clip(protect_edges, 0.0, 1.0))
    nlm_h = float(max(0.1, nlm_h))
    speck_threshold = int(max(1, speck_threshold))

    if strength == 0.0:
        return rgb.copy()

    texture_window = int(max(3, texture_window))
    if texture_window % 2 == 0:
        texture_window += 1

    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)
    L, A, B = cv2.split(lab)
    Lf = L.astype(np.float32)

    # Structural edges worth protecting.
    gx = cv2.Sobel(Lf, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(Lf, cv2.CV_32F, 0, 1, ksize=3)
    edge_energy = cv2.magnitude(gx, gy)
    edge_energy = cv2.GaussianBlur(edge_energy, (5, 5), 0)
    edge = _robust_unit(edge_energy)

    # Fine high-frequency texture energy.
    lap = np.abs(cv2.Laplacian(Lf, cv2.CV_32F, ksize=3))
    texture_energy = cv2.boxFilter(
        lap,
        ddepth=cv2.CV_32F,
        ksize=(texture_window, texture_window),
        normalize=True,
    )
    texture = _robust_unit(texture_energy)

    # High microtexture + weak structure = cleanup candidate.
    cleanup = np.clip((texture - 0.20) / 0.80, 0.0, 1.0)
    edge_protection = np.power(1.0 - edge, 1.0 + 4.0 * protect_edges)
    cleanup *= edge_protection
    cleanup = cv2.GaussianBlur(cleanup, (0, 0), 1.2)
    cleanup = np.clip(cleanup * strength, 0.0, 1.0)

    # Patch-based alternate luminance estimate.
    candidate = cv2.fastNlMeansDenoising(
        L,
        None,
        h=max(0.1, nlm_h * (0.35 + 0.95 * strength)),
        templateWindowSize=7,
        searchWindowSize=21,
    ).astype(np.float32)

    cleaned_L = Lf * (1.0 - cleanup) + candidate * cleanup

    # Isolated bright/dark speck cleanup.
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    opened = cv2.morphologyEx(L, cv2.MORPH_OPEN, kernel).astype(np.float32)
    closed = cv2.morphologyEx(L, cv2.MORPH_CLOSE, kernel).astype(np.float32)

    bright_hat = np.maximum(Lf - opened, 0.0)
    dark_hat = np.maximum(closed - Lf, 0.0)
    flat = np.power(1.0 - edge, 3.0)

    bright_mask = (
        bright_hat >= float(speck_threshold)
    ).astype(np.float32) * flat
    dark_mask = (
        dark_hat >= float(speck_threshold)
    ).astype(np.float32) * flat

    speck_amount = 0.85 * strength
    cleaned_L -= bright_hat * bright_mask * speck_amount
    cleaned_L += dark_hat * dark_mask * speck_amount
    cleaned_L = np.clip(cleaned_L, 0, 255).astype(np.uint8)

    out_lab = cv2.merge((cleaned_L, A, B))
    return cv2.cvtColor(out_lab, cv2.COLOR_LAB2RGB)


def read_image_rgb(path: str | Path) -> np.ndarray:
    """Unicode-path-safe image reader for Windows."""
    path = str(path)
    data = np.fromfile(path, dtype=np.uint8)
    bgr = cv2.imdecode(data, cv2.IMREAD_COLOR)

    if bgr is None:
        raise ValueError(f"Could not read image:\n{path}")

    return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)


def write_image_rgb(path: str | Path, rgb: np.ndarray) -> None:
    """Unicode-path-safe image writer for Windows."""
    path = Path(path)
    suffix = path.suffix.lower()

    if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
        path = path.with_suffix(".png")
        suffix = ".png"

    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    ext = ".jpg" if suffix == ".jpeg" else suffix
    params: list[int] = []

    if ext == ".jpg":
        params = [cv2.IMWRITE_JPEG_QUALITY, 96]
    elif ext == ".webp":
        params = [cv2.IMWRITE_WEBP_QUALITY, 96]

    ok, encoded = cv2.imencode(ext, bgr, params)
    if not ok:
        raise ValueError(f"Could not encode image as {ext}")

    encoded.tofile(str(path))


def fit_processing_preview(rgb: np.ndarray) -> np.ndarray:
    """Keep enough pixels for 1440p/2160p comparison while bounding CPU cost."""
    h, w = rgb.shape[:2]
    scale = min(
        PREVIEW_MAX_W / max(w, 1),
        PREVIEW_MAX_H / max(h, 1),
        1.0,
    )

    if scale >= 0.999:
        return rgb.copy()

    nw = max(1, int(round(w * scale)))
    nh = max(1, int(round(h * scale)))
    return cv2.resize(rgb, (nw, nh), interpolation=cv2.INTER_AREA)


class OverlayCompare(ttk.Frame):
    """Before/after overlay viewer with a draggable vertical divider."""

    def __init__(self, parent: tk.Misc, ui_scale: float = 1.0) -> None:
        super().__init__(parent)
        self.ui_scale = ui_scale
        self.split = OVERLAY_START
        self.original_rgb: np.ndarray | None = None
        self.cleaned_rgb: np.ndarray | None = None
        self._render_after_id: str | None = None

        self.original_photo: ImageTk.PhotoImage | None = None
        self.cleaned_photo: ImageTk.PhotoImage | None = None

        self.image_x = 0
        self.image_y = 0
        self.image_w = 0
        self.image_h = 0

        self.viewport = tk.Frame(self, bg="#101214", highlightthickness=0)
        self.viewport.pack(fill="both", expand=True)

        self.cleaned_label = tk.Label(
            self.viewport,
            bg="#101214",
            borderwidth=0,
            highlightthickness=0,
        )

        self.original_clip = tk.Frame(
            self.viewport,
            bg="#101214",
            borderwidth=0,
            highlightthickness=0,
        )

        self.original_label = tk.Label(
            self.original_clip,
            bg="#101214",
            borderwidth=0,
            highlightthickness=0,
        )

        self.divider = tk.Frame(
            self.viewport,
            bg="#e8c37a",
            cursor="sb_h_double_arrow",
        )

        label_font = ("Segoe UI", 10, "bold")
        self.original_tag = tk.Label(
            self.viewport,
            text="ORIGINAL",
            fg="#f4f4f4",
            bg="#1b1c1f",
            font=label_font,
            padx=max(6, int(8 * ui_scale)),
            pady=max(3, int(4 * ui_scale)),
        )
        self.cleaned_tag = tk.Label(
            self.viewport,
            text="CLEANED",
            fg="#f4f4f4",
            bg="#1b1c1f",
            font=label_font,
            padx=max(6, int(8 * ui_scale)),
            pady=max(3, int(4 * ui_scale)),
        )

        self.empty_label = tk.Label(
            self.viewport,
            text="Open an image to begin",
            fg="#a9adb4",
            bg="#101214",
            font=("Segoe UI", 18),
        )
        self.empty_label.place(relx=0.5, rely=0.5, anchor="center")

        self.hint_var = tk.StringVar(
            value="Drag across the image to compare original ↔ cleaned"
        )
        ttk.Label(
            self,
            textvariable=self.hint_var,
            anchor="center",
        ).pack(fill="x", pady=(8, 0))

        self.viewport.bind("<Configure>", self._schedule_render)
        for widget in (
            self.viewport,
            self.cleaned_label,
            self.original_clip,
            self.original_label,
            self.divider,
            self.original_tag,
            self.cleaned_tag,
        ):
            widget.bind("<Button-1>", self._drag)
            widget.bind("<B1-Motion>", self._drag)

    def set_images(
        self,
        original_rgb: np.ndarray,
        cleaned_rgb: np.ndarray | None,
    ) -> None:
        self.original_rgb = original_rgb
        self.cleaned_rgb = cleaned_rgb if cleaned_rgb is not None else original_rgb
        self.empty_label.place_forget()
        self._render_images()

    def clear(self) -> None:
        self.original_rgb = None
        self.cleaned_rgb = None
        self.cleaned_label.place_forget()
        self.original_clip.place_forget()
        self.divider.place_forget()
        self.original_tag.place_forget()
        self.cleaned_tag.place_forget()
        self.empty_label.place(relx=0.5, rely=0.5, anchor="center")

    def _schedule_render(self, _event: tk.Event | None = None) -> None:
        if self._render_after_id is not None:
            try:
                self.after_cancel(self._render_after_id)
            except tk.TclError:
                pass
        self._render_after_id = self.after(100, self._render_images)

    def _render_images(self) -> None:
        self._render_after_id = None
        if self.original_rgb is None or self.cleaned_rgb is None:
            return

        vw = max(1, self.viewport.winfo_width())
        vh = max(1, self.viewport.winfo_height())
        margin = max(8, int(12 * self.ui_scale))
        avail_w = max(1, vw - margin * 2)
        avail_h = max(1, vh - margin * 2)

        src_h, src_w = self.original_rgb.shape[:2]
        scale = min(avail_w / src_w, avail_h / src_h)
        display_w = max(1, int(round(src_w * scale)))
        display_h = max(1, int(round(src_h * scale)))

        original_pil = Image.fromarray(self.original_rgb)
        cleaned_pil = Image.fromarray(self.cleaned_rgb)
        resample = Image.Resampling.LANCZOS if scale < 1.0 else Image.Resampling.BICUBIC

        if (display_w, display_h) != original_pil.size:
            original_pil = original_pil.resize((display_w, display_h), resample)
            cleaned_pil = cleaned_pil.resize((display_w, display_h), resample)

        self.original_photo = ImageTk.PhotoImage(original_pil)
        self.cleaned_photo = ImageTk.PhotoImage(cleaned_pil)

        self.image_w = display_w
        self.image_h = display_h
        self.image_x = (vw - display_w) // 2
        self.image_y = (vh - display_h) // 2

        self.cleaned_label.configure(image=self.cleaned_photo)
        self.original_label.configure(image=self.original_photo)

        self.cleaned_label.place(
            x=self.image_x,
            y=self.image_y,
            width=display_w,
            height=display_h,
        )
        self.original_label.place(
            x=0,
            y=0,
            width=display_w,
            height=display_h,
        )

        self._apply_split()

    def _apply_split(self) -> None:
        if self.image_w <= 0 or self.image_h <= 0:
            return

        clip_w = max(1, min(self.image_w - 1, int(round(self.image_w * self.split))))
        divider_w = max(3, int(round(3 * self.ui_scale)))
        divider_x = self.image_x + clip_w - divider_w // 2

        self.original_clip.place(
            x=self.image_x,
            y=self.image_y,
            width=clip_w,
            height=self.image_h,
        )
        self.divider.place(
            x=divider_x,
            y=self.image_y,
            width=divider_w,
            height=self.image_h,
        )

        tag_pad = max(8, int(12 * self.ui_scale))
        self.original_tag.place(
            x=self.image_x + tag_pad,
            y=self.image_y + tag_pad,
            anchor="nw",
        )
        self.cleaned_tag.place(
            x=self.image_x + self.image_w - tag_pad,
            y=self.image_y + tag_pad,
            anchor="ne",
        )

        self.divider.lift()
        self.original_tag.lift()
        self.cleaned_tag.lift()

    def _drag(self, event: tk.Event) -> None:
        if self.image_w <= 0:
            return

        local_x = event.x_root - self.viewport.winfo_rootx()
        if local_x < self.image_x or local_x > self.image_x + self.image_w:
            return

        self.split = float(
            np.clip(
                (local_x - self.image_x) / self.image_w,
                0.01,
                0.99,
            )
        )
        self._apply_split()


class CleanerApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()

        self.title(APP_TITLE)
        self._configure_dpi_and_fonts()
        self._configure_window()

        self.original_full: np.ndarray | None = None
        self.original_preview: np.ndarray | None = None
        self.processed_preview: np.ndarray | None = None
        self.source_path: Path | None = None

        self.executor = ThreadPoolExecutor(max_workers=1)
        self.worker_results: queue.Queue[tuple] = queue.Queue()
        self.preview_job_id = 0
        self.preview_in_flight = False
        self.preview_pending = False
        self.pending_after_id: str | None = None
        self.save_in_progress = False
        self.fullscreen = False

        self._build_ui()
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.bind("<F11>", self._toggle_fullscreen)
        self.bind("<Escape>", self._leave_fullscreen)
        self.after(50, self._poll_worker_results)

        if sys.platform == "win32":
            self.after(0, self._maximize_window)

    def _configure_dpi_and_fonts(self) -> None:
        self.update_idletasks()
        dpi = 96.0

        if sys.platform == "win32":
            try:
                dpi = float(ctypes.windll.user32.GetDpiForWindow(self.winfo_id()))
            except Exception:
                dpi = float(self.winfo_fpixels("1i"))
        else:
            dpi = float(self.winfo_fpixels("1i"))

        dpi = max(72.0, dpi)
        self.ui_scale = max(1.0, min(3.0, dpi / 96.0))

        try:
            self.tk.call("tk", "scaling", dpi / 72.0)
        except tk.TclError:
            pass

        for name, size in (
            ("TkDefaultFont", 11),
            ("TkTextFont", 11),
            ("TkMenuFont", 11),
            ("TkHeadingFont", 12),
            ("TkCaptionFont", 11),
            ("TkSmallCaptionFont", 10),
        ):
            try:
                tkfont.nametofont(name).configure(family="Segoe UI", size=size)
            except tk.TclError:
                pass

    def _configure_window(self) -> None:
        sw = self.winfo_screenwidth()
        sh = self.winfo_screenheight()

        width = max(1100, int(sw * 0.92))
        height = max(760, int(sh * 0.90))
        width = min(width, sw)
        height = min(height, sh)
        x = max(0, (sw - width) // 2)
        y = max(0, (sh - height) // 2)

        self.geometry(f"{width}x{height}+{x}+{y}")
        self.minsize(min(1100, sw), min(720, sh))

    def _maximize_window(self) -> None:
        try:
            self.state("zoomed")
        except tk.TclError:
            pass

    def _build_ui(self) -> None:
        pad = max(8, int(12 * self.ui_scale))
        sidebar_width = max(330, int(360 * self.ui_scale))

        self.columnconfigure(0, minsize=sidebar_width, weight=0)
        self.columnconfigure(1, weight=1)
        self.rowconfigure(1, weight=1)

        toolbar = ttk.Frame(self, padding=(pad, pad, pad, max(6, pad // 2)))
        toolbar.grid(row=0, column=0, columnspan=2, sticky="ew")
        toolbar.columnconfigure(4, weight=1)

        ttk.Button(toolbar, text="Open Image", command=self.open_image).grid(
            row=0, column=0, padx=(0, 8)
        )

        self.save_button = ttk.Button(
            toolbar,
            text="Save As...",
            command=self.save_image,
            state="disabled",
        )
        self.save_button.grid(row=0, column=1, padx=(0, 8))

        ttk.Button(
            toolbar,
            text="Reset Sliders",
            command=self.reset_sliders,
        ).grid(row=0, column=2, padx=(0, 8))

        ttk.Button(
            toolbar,
            text="Fullscreen  F11",
            command=self._toggle_fullscreen,
        ).grid(row=0, column=3, padx=(0, 12))

        self.filename_var = tk.StringVar(value="No image loaded")
        ttk.Label(toolbar, textvariable=self.filename_var, anchor="w").grid(
            row=0, column=4, sticky="ew"
        )

        self.sidebar = ttk.Frame(self, padding=(pad, pad, pad, pad))
        self.sidebar.grid(row=1, column=0, sticky="nsew")
        self.sidebar.configure(width=sidebar_width)
        self.sidebar.grid_propagate(False)

        viewer_frame = ttk.Frame(self, padding=(0, pad, pad, pad))
        viewer_frame.grid(row=1, column=1, sticky="nsew")
        viewer_frame.rowconfigure(0, weight=1)
        viewer_frame.columnconfigure(0, weight=1)

        self.compare = OverlayCompare(viewer_frame, self.ui_scale)
        self.compare.grid(row=0, column=0, sticky="nsew")

        self.strength_var = tk.DoubleVar(value=65)
        self.nlm_var = tk.DoubleVar(value=8)
        self.texture_var = tk.DoubleVar(value=9)
        self.edge_var = tk.DoubleVar(value=80)
        self.speck_var = tk.DoubleVar(value=10)

        ttk.Label(
            self.sidebar,
            text="Artifact Cleaner",
            font=("Segoe UI", 18, "bold"),
        ).pack(anchor="w", pady=(0, max(8, int(12 * self.ui_scale))))

        ttk.Label(
            self.sidebar,
            text=(
                "Cleaned image sits underneath the original. "
                "Drag the gold divider directly on the image to compare."
            ),
            wraplength=max(260, int(310 * self.ui_scale)),
            justify="left",
        ).pack(anchor="w", pady=(0, max(10, int(18 * self.ui_scale))))

        self._add_slider(
            "Cleanup strength",
            self.strength_var,
            0,
            100,
            "Overall amount of artifact cleanup",
        )
        self._add_slider(
            "Patch cleanup",
            self.nlm_var,
            1,
            20,
            "Non-Local Means patch reconstruction strength",
        )
        self._add_slider(
            "Texture window",
            self.texture_var,
            3,
            21,
            "Scale used to measure fine texture",
        )
        self._add_slider(
            "Edge protection",
            self.edge_var,
            0,
            100,
            "Higher values protect meaningful edges more aggressively",
        )
        self._add_slider(
            "Speck threshold",
            self.speck_var,
            2,
            40,
            "Higher values target only stronger isolated specks",
        )

        ttk.Separator(self.sidebar, orient="horizontal").pack(
            fill="x", pady=max(10, int(14 * self.ui_scale))
        )

        self.status_var = tk.StringVar(value="Open an image to begin.")
        ttk.Label(
            self.sidebar,
            textvariable=self.status_var,
            wraplength=max(260, int(310 * self.ui_scale)),
            justify="left",
        ).pack(anchor="w")

        self.resolution_var = tk.StringVar(value=self._display_resolution_text())
        ttk.Label(
            self.sidebar,
            textvariable=self.resolution_var,
            wraplength=max(260, int(310 * self.ui_scale)),
            justify="left",
        ).pack(anchor="w", pady=(max(8, int(12 * self.ui_scale)), 0))

    def _display_resolution_text(self) -> str:
        return (
            f"Display: {self.winfo_screenwidth()}×{self.winfo_screenheight()}  •  "
            f"DPI scale: {self.ui_scale:.2f}×"
        )

    def _add_slider(
        self,
        title: str,
        variable: tk.DoubleVar,
        low: float,
        high: float,
        help_text: str,
    ) -> None:
        frame = ttk.Frame(self.sidebar)
        frame.pack(fill="x", pady=(0, max(9, int(13 * self.ui_scale))))

        header = ttk.Frame(frame)
        header.pack(fill="x")

        ttk.Label(
            header,
            text=title,
            font=("Segoe UI", 11, "bold"),
        ).pack(side="left")

        value_label = ttk.Label(header, width=6, anchor="e")
        value_label.pack(side="right")

        def refresh_value(*_args) -> None:
            value = variable.get()
            if title in {"Cleanup strength", "Edge protection"}:
                value_label.configure(text=f"{int(round(value))}%")
            else:
                value_label.configure(text=f"{int(round(value))}")

        variable.trace_add("write", refresh_value)
        refresh_value()

        ttk.Scale(
            frame,
            from_=low,
            to=high,
            variable=variable,
            command=lambda _value: self.schedule_preview(),
        ).pack(fill="x", pady=(max(3, int(4 * self.ui_scale)), 2))

        ttk.Label(
            frame,
            text=help_text,
            wraplength=max(250, int(300 * self.ui_scale)),
        ).pack(anchor="w")

    def current_settings(self) -> dict[str, float | int]:
        texture_window = int(round(self.texture_var.get()))
        if texture_window % 2 == 0:
            texture_window += 1

        return {
            "strength": self.strength_var.get() / 100.0,
            "nlm_h": self.nlm_var.get(),
            "texture_window": texture_window,
            "protect_edges": self.edge_var.get() / 100.0,
            "speck_threshold": int(round(self.speck_var.get())),
        }

    def reset_sliders(self) -> None:
        self.strength_var.set(65)
        self.nlm_var.set(8)
        self.texture_var.set(9)
        self.edge_var.set(80)
        self.speck_var.set(10)
        self.schedule_preview()

    def open_image(self) -> None:
        filename = filedialog.askopenfilename(
            title="Open image",
            filetypes=[
                ("Images", "*.png *.jpg *.jpeg *.webp *.bmp *.tif *.tiff"),
                ("All files", "*.*"),
            ],
        )

        if not filename:
            return

        try:
            full = read_image_rgb(filename)
        except Exception as exc:
            messagebox.showerror(APP_TITLE, f"Could not open image.\n\n{exc}")
            return

        self.source_path = Path(filename)
        self.original_full = full
        self.original_preview = fit_processing_preview(full)
        self.processed_preview = None

        h, w = full.shape[:2]
        ph, pw = self.original_preview.shape[:2]

        self.filename_var.set(f"{self.source_path.name}   {w}×{h}")
        self.resolution_var.set(
            f"Source: {w}×{h}  •  Preview: {pw}×{ph}\n"
            + self._display_resolution_text()
        )
        self.save_button.configure(state="normal")

        # Show the image immediately. Cleaned side becomes meaningful when processing ends.
        self.compare.split = OVERLAY_START
        self.compare.set_images(self.original_preview, self.original_preview)
        self.status_var.set("Processing high-resolution preview...")
        self.request_preview()

    def schedule_preview(self) -> None:
        if self.original_preview is None:
            return

        if self.pending_after_id is not None:
            try:
                self.after_cancel(self.pending_after_id)
            except tk.TclError:
                pass

        self.pending_after_id = self.after(350, self.request_preview)

    def request_preview(self) -> None:
        self.pending_after_id = None
        if self.original_preview is None:
            return

        if self.preview_in_flight:
            self.preview_pending = True
            self.status_var.set("Settings changed — waiting to refresh preview...")
            return

        self.preview_job_id += 1
        job_id = self.preview_job_id
        image = self.original_preview.copy()
        settings = self.current_settings()

        self.preview_in_flight = True
        self.preview_pending = False
        self.status_var.set("Processing high-resolution preview...")

        future = self.executor.submit(clean_rgb, image, **settings)

        def done_callback(fut) -> None:
            try:
                result = fut.result()
                error = None
            except Exception as exc:
                result = None
                error = exc
            self.worker_results.put(("preview", job_id, result, error))

        future.add_done_callback(done_callback)

    def _finish_preview(
        self,
        job_id: int,
        result: np.ndarray | None,
        error: Exception | None,
    ) -> None:
        self.preview_in_flight = False

        if error is not None:
            self.status_var.set("Preview failed.")
            messagebox.showerror(APP_TITLE, f"Preview processing failed.\n\n{error}")
        elif result is not None and job_id == self.preview_job_id:
            self.processed_preview = result
            if self.original_preview is not None:
                self.compare.set_images(self.original_preview, result)
            self.status_var.set("Preview ready. Drag the gold divider to compare.")

        if self.preview_pending:
            self.preview_pending = False
            self.after_idle(self.request_preview)

    def save_image(self) -> None:
        if self.original_full is None or self.save_in_progress:
            return

        source_stem = self.source_path.stem if self.source_path is not None else "image"
        filename = filedialog.asksaveasfilename(
            title="Save cleaned image",
            defaultextension=".png",
            initialfile=f"{source_stem}_cleaned.png",
            filetypes=[
                ("PNG image", "*.png"),
                ("JPEG image", "*.jpg *.jpeg"),
                ("WebP image", "*.webp"),
            ],
        )

        if not filename:
            return

        image = self.original_full.copy()
        settings = self.current_settings()
        self.save_in_progress = True
        self.save_button.configure(state="disabled")
        self.status_var.set("Processing full-resolution image...")

        future = self.executor.submit(clean_rgb, image, **settings)

        def done_callback(fut) -> None:
            try:
                result = fut.result()
                write_image_rgb(filename, result)
                error = None
            except Exception as exc:
                error = exc
            self.worker_results.put(("save", filename, error))

        future.add_done_callback(done_callback)

    def _finish_save(self, filename: str, error: Exception | None) -> None:
        self.save_in_progress = False
        self.save_button.configure(state="normal")

        if error is not None:
            self.status_var.set("Save failed.")
            messagebox.showerror(APP_TITLE, f"Could not save image.\n\n{error}")
            return

        self.status_var.set(f"Saved: {Path(filename).name}")
        messagebox.showinfo(APP_TITLE, f"Saved cleaned image:\n\n{filename}")

    def _poll_worker_results(self) -> None:
        try:
            while True:
                message = self.worker_results.get_nowait()
                if message[0] == "preview":
                    _, job_id, result, error = message
                    self._finish_preview(job_id, result, error)
                elif message[0] == "save":
                    _, filename, error = message
                    self._finish_save(filename, error)
        except queue.Empty:
            pass

        if self.winfo_exists():
            self.after(50, self._poll_worker_results)

    def _toggle_fullscreen(self, _event: tk.Event | None = None) -> str:
        self.fullscreen = not self.fullscreen
        self.attributes("-fullscreen", self.fullscreen)
        return "break"

    def _leave_fullscreen(self, _event: tk.Event | None = None) -> str:
        if self.fullscreen:
            self.fullscreen = False
            self.attributes("-fullscreen", False)
        return "break"

    def _on_close(self) -> None:
        self.preview_job_id += 1
        self.executor.shutdown(wait=False, cancel_futures=True)
        self.destroy()


def main() -> None:
    enable_high_dpi_awareness()
    app = CleanerApp()
    app.mainloop()


if __name__ == "__main__":
    main()