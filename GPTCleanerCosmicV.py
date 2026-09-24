from __future__ import annotations

import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageTk


APP_TITLE = "GPTCleaner CosmicV"
PREVIEW_MAX_W = 900
PREVIEW_MAX_H = 720


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

    gx = cv2.Sobel(Lf, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(Lf, cv2.CV_32F, 0, 1, ksize=3)
    edge_energy = cv2.magnitude(gx, gy)
    edge_energy = cv2.GaussianBlur(edge_energy, (5, 5), 0)
    edge = _robust_unit(edge_energy)

    lap = np.abs(cv2.Laplacian(Lf, cv2.CV_32F, ksize=3))
    texture_energy = cv2.boxFilter(
        lap,
        ddepth=cv2.CV_32F,
        ksize=(texture_window, texture_window),
        normalize=True,
    )
    texture = _robust_unit(texture_energy)

    cleanup = np.clip((texture - 0.20) / 0.80, 0.0, 1.0)
    edge_protection = np.power(1.0 - edge, 1.0 + 4.0 * protect_edges)
    cleanup *= edge_protection
    cleanup = cv2.GaussianBlur(cleanup, (0, 0), 1.2)
    cleanup = np.clip(cleanup * strength, 0.0, 1.0)

    candidate = cv2.fastNlMeansDenoising(
        L,
        None,
        h=max(0.1, nlm_h * (0.35 + 0.95 * strength)),
        templateWindowSize=7,
        searchWindowSize=21,
    ).astype(np.float32)

    cleaned_L = Lf * (1.0 - cleanup) + candidate * cleanup

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))

    opened = cv2.morphologyEx(
        L, cv2.MORPH_OPEN, kernel
    ).astype(np.float32)

    closed = cv2.morphologyEx(
        L, cv2.MORPH_CLOSE, kernel
    ).astype(np.float32)

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


def fit_preview(rgb: np.ndarray) -> np.ndarray:
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

    return cv2.resize(
        rgb,
        (nw, nh),
        interpolation=cv2.INTER_AREA,
    )


class CleanerApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()

        self.title(APP_TITLE)
        self.geometry("1280x820")
        self.minsize(980, 700)

        self.original_full: np.ndarray | None = None
        self.original_preview: np.ndarray | None = None
        self.processed_preview: np.ndarray | None = None
        self.source_path: Path | None = None

        self.before_photo: ImageTk.PhotoImage | None = None
        self.after_photo: ImageTk.PhotoImage | None = None

        self.executor = ThreadPoolExecutor(max_workers=1)
        self.preview_job_id = 0
        self.pending_after_id: str | None = None
        self.save_in_progress = False

        self._build_ui()
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    def _build_ui(self) -> None:
        root = ttk.Frame(self, padding=12)
        root.pack(fill="both", expand=True)

        toolbar = ttk.Frame(root)
        toolbar.pack(fill="x", pady=(0, 10))

        ttk.Button(
            toolbar,
            text="Open Image",
            command=self.open_image,
        ).pack(side="left")

        self.save_button = ttk.Button(
            toolbar,
            text="Save As...",
            command=self.save_image,
            state="disabled",
        )
        self.save_button.pack(side="left", padx=(8, 0))

        ttk.Button(
            toolbar,
            text="Reset Sliders",
            command=self.reset_sliders,
        ).pack(side="left", padx=(8, 0))

        self.filename_var = tk.StringVar(value="No image loaded")
        ttk.Label(
            toolbar,
            textvariable=self.filename_var,
        ).pack(side="left", padx=14)

        content = ttk.Panedwindow(root, orient="horizontal")
        content.pack(fill="both", expand=True)

        controls = ttk.Frame(content, padding=(0, 4, 12, 4))
        preview_area = ttk.Frame(content)

        content.add(controls, weight=0)
        content.add(preview_area, weight=1)

        self.strength_var = tk.DoubleVar(value=65)
        self.nlm_var = tk.DoubleVar(value=8)
        self.texture_var = tk.DoubleVar(value=9)
        self.edge_var = tk.DoubleVar(value=80)
        self.speck_var = tk.DoubleVar(value=10)

        ttk.Label(
            controls,
            text="Artifact Cleaner",
            font=("Segoe UI", 15, "bold"),
        ).pack(anchor="w", pady=(0, 12))

        ttk.Label(
            controls,
            text=(
                "The preview updates after you stop moving a slider.\n"
                "Saving processes the original full-resolution image."
            ),
            wraplength=260,
            justify="left",
        ).pack(anchor="w", pady=(0, 16))

        self._add_slider(
            controls,
            "Cleanup strength",
            self.strength_var,
            0,
            100,
            "Overall amount of artifact cleanup",
        )

        self._add_slider(
            controls,
            "Patch cleanup",
            self.nlm_var,
            1,
            20,
            "Strength of Non-Local Means patch reconstruction",
        )

        self._add_slider(
            controls,
            "Texture window",
            self.texture_var,
            3,
            21,
            "Scale used to measure fine texture",
        )

        self._add_slider(
            controls,
            "Edge protection",
            self.edge_var,
            0,
            100,
            "Higher values protect meaningful edges more aggressively",
        )

        self._add_slider(
            controls,
            "Speck threshold",
            self.speck_var,
            2,
            40,
            "Higher values remove only stronger isolated specks",
        )

        ttk.Separator(
            controls,
            orient="horizontal",
        ).pack(fill="x", pady=16)

        self.status_var = tk.StringVar(
            value="Open an image to begin."
        )

        ttk.Label(
            controls,
            textvariable=self.status_var,
            wraplength=260,
            justify="left",
        ).pack(anchor="w")

        previews = ttk.Panedwindow(
            preview_area,
            orient="horizontal",
        )
        previews.pack(fill="both", expand=True)

        before_frame = ttk.LabelFrame(
            previews,
            text="Original",
            padding=8,
        )
        after_frame = ttk.LabelFrame(
            previews,
            text="Cleaned Preview",
            padding=8,
        )

        previews.add(before_frame, weight=1)
        previews.add(after_frame, weight=1)

        self.before_label = ttk.Label(
            before_frame,
            anchor="center",
        )
        self.before_label.pack(fill="both", expand=True)

        self.after_label = ttk.Label(
            after_frame,
            anchor="center",
        )
        self.after_label.pack(fill="both", expand=True)

    def _add_slider(
        self,
        parent: ttk.Frame,
        title: str,
        variable: tk.DoubleVar,
        low: float,
        high: float,
        help_text: str,
    ) -> None:
        frame = ttk.Frame(parent)
        frame.pack(fill="x", pady=(0, 14))

        header = ttk.Frame(frame)
        header.pack(fill="x")

        ttk.Label(
            header,
            text=title,
            font=("Segoe UI", 10, "bold"),
        ).pack(side="left")

        value_label = ttk.Label(
            header,
            width=6,
            anchor="e",
        )
        value_label.pack(side="right")

        def refresh_value(*_args) -> None:
            value = variable.get()

            if title in {
                "Cleanup strength",
                "Edge protection",
            }:
                value_label.configure(text=f"{int(round(value))}%")
            else:
                value_label.configure(text=f"{int(round(value))}")

        variable.trace_add("write", refresh_value)
        refresh_value()

        scale = ttk.Scale(
            frame,
            from_=low,
            to=high,
            variable=variable,
            command=lambda _value: self.schedule_preview(),
        )
        scale.pack(fill="x", pady=(4, 2))

        ttk.Label(
            frame,
            text=help_text,
            wraplength=250,
            foreground="#666666",
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
                (
                    "Images",
                    "*.png *.jpg *.jpeg *.webp *.bmp *.tif *.tiff",
                ),
                ("All files", "*.*"),
            ],
        )

        if not filename:
            return

        try:
            full = read_image_rgb(filename)
        except Exception as exc:
            messagebox.showerror(
                APP_TITLE,
                f"Could not open image.\n\n{exc}",
            )
            return

        self.source_path = Path(filename)
        self.original_full = full
        self.original_preview = fit_preview(full)
        self.processed_preview = None

        h, w = full.shape[:2]

        self.filename_var.set(
            f"{self.source_path.name}   {w}×{h}"
        )
        self.save_button.configure(state="normal")

        self._show_before(self.original_preview)

        self.after_label.configure(
            image="",
            text="Processing...",
        )
        self.after_photo = None

        self.request_preview()

    def schedule_preview(self) -> None:
        if self.original_preview is None:
            return

        if self.pending_after_id is not None:
            try:
                self.after_cancel(self.pending_after_id)
            except tk.TclError:
                pass

        self.pending_after_id = self.after(
            280,
            self.request_preview,
        )

    def request_preview(self) -> None:
        self.pending_after_id = None

        if self.original_preview is None:
            return

        self.preview_job_id += 1
        job_id = self.preview_job_id

        image = self.original_preview.copy()
        settings = self.current_settings()

        self.status_var.set("Processing preview...")

        future = self.executor.submit(
            clean_rgb,
            image,
            **settings,
        )

        def done_callback(fut) -> None:
            try:
                result = fut.result()
                error = None
            except Exception as exc:
                result = None
                error = exc

            self.after(
                0,
                self._finish_preview,
                job_id,
                result,
                error,
            )

        future.add_done_callback(done_callback)

    def _finish_preview(
        self,
        job_id: int,
        result: np.ndarray | None,
        error: Exception | None,
    ) -> None:
        if job_id != self.preview_job_id:
            return

        if error is not None:
            self.status_var.set("Preview failed.")
            messagebox.showerror(
                APP_TITLE,
                f"Preview processing failed.\n\n{error}",
            )
            return

        if result is None:
            return

        self.processed_preview = result
        self._show_after(result)
        self.status_var.set("Preview ready.")

    def _show_before(self, rgb: np.ndarray) -> None:
        photo = self._photo_for_label(
            rgb,
            self.before_label,
        )
        self.before_photo = photo
        self.before_label.configure(
            image=photo,
            text="",
        )

    def _show_after(self, rgb: np.ndarray) -> None:
        photo = self._photo_for_label(
            rgb,
            self.after_label,
        )
        self.after_photo = photo
        self.after_label.configure(
            image=photo,
            text="",
        )

    def _photo_for_label(
        self,
        rgb: np.ndarray,
        label: ttk.Label,
    ) -> ImageTk.PhotoImage:
        pil = Image.fromarray(rgb)

        label.update_idletasks()

        max_w = max(200, label.winfo_width() - 16)
        max_h = max(200, label.winfo_height() - 16)

        w, h = pil.size
        scale = min(
            max_w / max(w, 1),
            max_h / max(h, 1),
            1.0,
        )

        if scale < 0.999:
            size = (
                max(1, int(w * scale)),
                max(1, int(h * scale)),
            )
            pil = pil.resize(
                size,
                Image.Resampling.LANCZOS,
            )

        return ImageTk.PhotoImage(pil)

    def save_image(self) -> None:
        if self.original_full is None:
            return

        if self.save_in_progress:
            return

        source_stem = (
            self.source_path.stem
            if self.source_path is not None
            else "image"
        )

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
        self.status_var.set(
            "Processing full-resolution image..."
        )

        future = self.executor.submit(
            clean_rgb,
            image,
            **settings,
        )

        def done_callback(fut) -> None:
            try:
                result = fut.result()
                write_image_rgb(filename, result)
                error = None
            except Exception as exc:
                error = exc

            self.after(
                0,
                self._finish_save,
                filename,
                error,
            )

        future.add_done_callback(done_callback)

    def _finish_save(
        self,
        filename: str,
        error: Exception | None,
    ) -> None:
        self.save_in_progress = False
        self.save_button.configure(state="normal")

        if error is not None:
            self.status_var.set("Save failed.")
            messagebox.showerror(
                APP_TITLE,
                f"Could not save image.\n\n{error}",
            )
            return

        self.status_var.set(
            f"Saved: {Path(filename).name}"
        )

        messagebox.showinfo(
            APP_TITLE,
            f"Saved cleaned image:\n\n{filename}",
        )

    def _on_close(self) -> None:
        self.preview_job_id += 1
        self.executor.shutdown(
            wait=False,
            cancel_futures=True,
        )
        self.destroy()


def main() -> None:
    app = CleanerApp()
    app.mainloop()


if __name__ == "__main__":
    main()
