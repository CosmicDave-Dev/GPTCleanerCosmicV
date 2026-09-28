export class SplitViewer {
  constructor(canvas, dividerEl, beforeTagEl, afterTagEl, emptyStateEl) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.dividerEl = dividerEl;
    this.beforeTagEl = beforeTagEl;
    this.afterTagEl = afterTagEl;
    this.emptyStateEl = emptyStateEl;

    this.beforeImage = null;
    this.afterImage = null;
    this.targetMaskImage = null;
    this.showTargetMask = false;
    this.split = 0.5;
    this.showSplit = true;
    this.swapMode = false;

    this.scale = 1;
    this.fitScale = 1;
    this.offsetX = 0;
    this.offsetY = 0;

    this.isDraggingDivider = false;
    this.isPanning = false;
    this.panStart = null;

    this.resizeObserver = new ResizeObserver(() => {
      this.resizeCanvas();
      if (this.beforeImage) this.fitToView();
      else this.render();
    });
    this.resizeObserver.observe(this.canvas.parentElement);

    this.attachEvents();
    this.resizeCanvas();
    this.render();
  }

  attachEvents() {
    this.dividerEl.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.isDraggingDivider = true;
      this.dividerEl.setPointerCapture?.(e.pointerId);
    });

    window.addEventListener("pointerup", () => {
      this.isDraggingDivider = false;
      this.isPanning = false;
      this.panStart = null;
    });

    window.addEventListener("pointermove", (e) => {
      if (this.isDraggingDivider) {
        const rect = this.canvas.getBoundingClientRect();
        this.split = Math.max(
          0.01,
          Math.min(0.99, (e.clientX - rect.left) / rect.width)
        );
        this.render();
        return;
      }

      if (this.isPanning && this.panStart) {
        this.offsetX = this.panStart.originX + (e.clientX - this.panStart.x);
        this.offsetY = this.panStart.originY + (e.clientY - this.panStart.y);
        this.render();
      }
    });

    this.canvas.addEventListener("pointerdown", (e) => {
      if (!this.beforeImage || e.button !== 0) return;
      this.isPanning = true;
      this.panStart = {
        x: e.clientX,
        y: e.clientY,
        originX: this.offsetX,
        originY: this.offsetY,
      };
      this.canvas.setPointerCapture?.(e.pointerId);
    });

    this.canvas.addEventListener(
      "wheel",
      (e) => {
        if (!this.beforeImage) return;
        e.preventDefault();

        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const imageX = (mouseX - this.offsetX) / this.scale;
        const imageY = (mouseY - this.offsetY) / this.scale;

        const multiplier = e.deltaY < 0 ? 1.14 : 1 / 1.14;
        const minScale = Math.max(0.02, this.fitScale * 0.25);
        const maxScale = 8;
        const nextScale = Math.max(
          minScale,
          Math.min(maxScale, this.scale * multiplier)
        );

        this.scale = nextScale;
        this.offsetX = mouseX - imageX * this.scale;
        this.offsetY = mouseY - imageY * this.scale;
        this.render();
      },
      { passive: false }
    );
  }

  resizeCanvas() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);

    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.viewportWidth = rect.width;
    this.viewportHeight = rect.height;
  }

  async setImageFromFile(file) {
    const bitmap = await createImageBitmap(file);
    this.setImages(bitmap, bitmap);
  }

  setImages(beforeImage, afterImage, targetMaskImage = null, preserveView = false) {
    const previousAfter = this.afterImage;
    const previousMask = this.targetMaskImage;

    this.beforeImage = beforeImage;
    this.afterImage = afterImage;
    this.targetMaskImage = targetMaskImage;
    this.emptyStateEl.classList.add("hidden");

    if (previousAfter && previousAfter !== beforeImage && previousAfter !== afterImage) {
      previousAfter.close?.();
    }
    if (
      previousMask &&
      previousMask !== previousAfter &&
      previousMask !== beforeImage &&
      previousMask !== targetMaskImage
    ) {
      previousMask.close?.();
    }

    if (preserveView) this.render();
    else this.fitToView();
  }

  toggleTargetMask() {
    if (!this.targetMaskImage) return false;
    this.showTargetMask = !this.showTargetMask;
    this.render();
    return this.showTargetMask;
  }

  clear() {
    this.beforeImage?.close?.();
    if (this.afterImage !== this.beforeImage) this.afterImage?.close?.();
    if (
      this.targetMaskImage &&
      this.targetMaskImage !== this.beforeImage &&
      this.targetMaskImage !== this.afterImage
    ) {
      this.targetMaskImage.close?.();
    }
    this.beforeImage = null;
    this.afterImage = null;
    this.targetMaskImage = null;
    this.showTargetMask = false;
    this.swapMode = false;
    this.emptyStateEl.classList.remove("hidden");
    this.render();
  }

  fitToView() {
    if (!this.beforeImage) {
      this.render();
      return;
    }

    const cw = this.viewportWidth || this.canvas.clientWidth;
    const ch = this.viewportHeight || this.canvas.clientHeight;
    const iw = this.beforeImage.width;
    const ih = this.beforeImage.height;

    this.fitScale = Math.min(cw / iw, ch / ih);
    this.scale = this.fitScale;
    this.offsetX = (cw - iw * this.scale) / 2;
    this.offsetY = (ch - ih * this.scale) / 2;
    this.render();
  }

  oneToOne() {
    if (!this.beforeImage) return;
    const cw = this.viewportWidth || this.canvas.clientWidth;
    const ch = this.viewportHeight || this.canvas.clientHeight;
    this.scale = 1;
    this.offsetX = (cw - this.beforeImage.width) / 2;
    this.offsetY = (ch - this.beforeImage.height) / 2;
    this.render();
  }

  toggleSplit() {
    this.showSplit = !this.showSplit;
    this.render();
  }

  swapImages() {
    if (!this.beforeImage || !this.afterImage) return;
    this.swapMode = !this.swapMode;
    this.render();
  }

  getCurrentOutputCanvas() {
    if (!this.afterImage) return null;
    const out = document.createElement("canvas");
    out.width = this.afterImage.width;
    out.height = this.afterImage.height;
    out.getContext("2d").drawImage(this.afterImage, 0, 0);
    return out;
  }

  render() {
    const ctx = this.ctx;
    const cw = this.viewportWidth || this.canvas.clientWidth || 1;
    const ch = this.viewportHeight || this.canvas.clientHeight || 1;

    ctx.save();
    ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = "#0c111a";
    ctx.fillRect(0, 0, cw, ch);

    if (!this.beforeImage || !this.afterImage) {
      this.dividerEl.style.display = "none";
      this.beforeTagEl.style.display = "none";
      this.afterTagEl.style.display = "none";
      ctx.restore();
      return;
    }

    this.beforeTagEl.style.display = "block";
    this.afterTagEl.style.display = "block";

    const processedImage =
      this.showTargetMask && this.targetMaskImage
        ? this.targetMaskImage
        : this.afterImage;
    const processedLabel =
      this.showTargetMask && this.targetMaskImage ? "MASK" : "AFTER";

    const leftImage = this.swapMode ? processedImage : this.beforeImage;
    const rightImage = this.swapMode ? this.beforeImage : processedImage;

    this.beforeTagEl.textContent = this.swapMode
      ? processedLabel
      : "BEFORE";
    this.afterTagEl.textContent = this.swapMode
      ? "BEFORE"
      : processedLabel;

    const drawX = this.offsetX;
    const drawY = this.offsetY;
    const drawW = this.beforeImage.width * this.scale;
    const drawH = this.beforeImage.height * this.scale;

    ctx.drawImage(rightImage, drawX, drawY, drawW, drawH);

    if (this.showSplit) {
      const splitX = this.split * cw;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, splitX, ch);
      ctx.clip();
      ctx.drawImage(leftImage, drawX, drawY, drawW, drawH);
      ctx.restore();

      this.dividerEl.style.display = "block";
      this.dividerEl.style.left = `${splitX}px`;
    } else {
      this.dividerEl.style.display = "none";
    }

    ctx.restore();
  }
}
