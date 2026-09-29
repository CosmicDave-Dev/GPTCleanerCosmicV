import { chromium, firefox } from "playwright";
import assert from "node:assert/strict";

const browserName = process.env.BROWSER || "chromium";
const browserType = { chromium, firefox }[browserName];

if (!browserType) {
  throw new Error(`Unsupported BROWSER=${browserName}`);
}

const browser = await browserType.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });

// Native filesystem pickers are browser UI, not page UI, so headless automation
// cannot operate them. Force the portable download fallback for smoke coverage.
// Production Chromium still uses showSaveFilePicker when a human clicks Save As.
await page.addInitScript(() => {
  try {
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: undefined,
    });
  } catch {
    window.showSaveFilePicker = undefined;
  }
});

const pageErrors = [];
page.on("pageerror", (error) => {
  pageErrors.push(error.message || String(error));
});

try {
  await page.goto("http://127.0.0.1:8000/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  await page.waitForSelector(".brand-title");
  const subtitle = await page.locator(".brand-subtitle").textContent();
  assert.match(subtitle || "", /Web V1\.0/);

  const dividerWidth = await page.locator("#divider").evaluate(
    (element) => parseFloat(getComputedStyle(element).width)
  );
  assert.ok(dividerWidth >= 12, `divider hitbox too narrow: ${dividerWidth}px`);

  assert.equal(await page.locator("#topOpenBtn").count(), 1);
  assert.equal(await page.locator("#saveBtn").count(), 1);
  assert.equal(await page.locator("#saveAsBtn").count(), 1);
  assert.equal(await page.locator("#topTargetMaskBtn").count(), 1);
  assert.equal(await page.locator("#infoBtn").count(), 1);
  assert.equal(await page.locator("#fullscreenBtn").count(), 1);
  assert.equal(await page.locator("#savePngBtn").count(), 0);

  assert.equal(
    (await page.locator("#fullscreenBtn").textContent())?.trim(),
    "F11 Fullscreen"
  );


  const sidebarOrder = await page.evaluate(() => {
    const sidebar = document.querySelector(".sidebar");
    const status = document.querySelector(".status-panel-top");
    const tabs = document.querySelector(".tabbar");

    return {
      hasTopStatus: Boolean(status),
      statusBeforeTabs:
        Boolean(sidebar && status && tabs) &&
        [...sidebar.children].indexOf(status) <
          [...sidebar.children].indexOf(tabs),
    };
  });

  assert.equal(sidebarOrder.hasTopStatus, true);
  assert.equal(sidebarOrder.statusBeforeTabs, true);


  await page.locator('[data-tab="cleanup"]').click();
  const edgeSlider = page.locator("#edgeCrunchRange");
  const edgeBox = await edgeSlider.boundingBox();
  assert.ok(edgeBox && edgeBox.height >= 22, "slider hitbox is not thumb-height");

  const beforeSliderValue = Number(await edgeSlider.inputValue());
  await page.mouse.click(
    edgeBox.x + edgeBox.width * 0.82,
    edgeBox.y + 2
  );
  const afterSliderValue = Number(await edgeSlider.inputValue());

  assert.notEqual(
    afterSliderValue,
    beforeSliderValue,
    "clicking near the top edge of the slider hitbox did not change the value"
  );

  await page.locator('[data-tab="quick"]').click();

  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 80;
    const ctx = canvas.getContext("2d");

    const gradient = ctx.createLinearGradient(0, 0, 96, 80);
    gradient.addColorStop(0, "#101828");
    gradient.addColorStop(0.45, "#d97706");
    gradient.addColorStop(1, "#22d3ee");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 96, 80);

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    for (let x = 4; x < 96; x += 7) {
      ctx.beginPath();
      ctx.moveTo(x, 4);
      ctx.lineTo(Math.min(95, x + 16), 76);
      ctx.stroke();
    }

    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/png")
    );

    const file = new File([blob], "cosmicv-smoke.png", {
      type: "image/png",
    });

    const transfer = new DataTransfer();
    transfer.items.add(file);

    const input = document.querySelector("#fileInput");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await page.waitForFunction(
    () => document.body.classList.contains("processing"),
    null,
    { timeout: 10000 }
  );

  const processingColor = await page.locator("#statusText").evaluate(
    (element) => getComputedStyle(element).color
  );
  assert.match(processingColor, /rgb\(57, 215, 255\)/);

  await page.waitForFunction(
    () => document.querySelector("#statusText")?.textContent?.includes("EdgeCrunch ready"),
    null,
    { timeout: 120000 }
  );

  await page.locator("#topTargetMaskBtn").click();
  assert.equal(
    await page.locator("#topTargetMaskBtn").getAttribute("aria-pressed"),
    "true"
  );
  assert.equal(
    await page.locator("#targetMaskBtn").getAttribute("aria-pressed"),
    "true"
  );
  await page.locator("#topTargetMaskBtn").click();
  assert.equal(
    await page.locator("#topTargetMaskBtn").getAttribute("aria-pressed"),
    "false"
  );

  await page.locator("#infoBtn").click();
  await page.waitForFunction(
    () => document.querySelector("#statusText")?.textContent?.includes("local browser processing"),
    null,
    { timeout: 5000 }
  );

  await page.locator('[data-tab="color"]').click();
  await page.locator("#brightnessRange").evaluate((element) => {
    element.value = "18";
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });

  await page.waitForTimeout(250);

  await page.locator('[data-tab="transform"]').click();
  await page.locator("#rotateRightBtn").click();
  await page.waitForFunction(
    () => document.querySelector("#rotationStatus")?.textContent?.includes("90°"),
    null,
    { timeout: 5000 }
  );

  await page.locator("#resetTransformBtn").click();
  await page.locator('[data-tab="quick"]').click();

  await page.locator("#saveAsBtn").click();
  await page.waitForSelector("#saveAsMenu:not(.hidden)");

  await page.locator('.save-format-btn[data-format="png"]').click();
  await page.waitForSelector("#fallbackSaveDialog:not(.hidden)");
  await page.locator("#fallbackSaveName").fill("cosmicv-custom-name");

  const downloadPromise = page.waitForEvent("download", {
    timeout: 120000,
  });
  await page.locator("#fallbackSaveConfirm").click();
  const download = await downloadPromise;

  assert.equal(download.suggestedFilename(), "cosmicv-custom-name.png");

  await page.waitForFunction(
    () =>
      document
        .querySelector("#statusText")
        ?.textContent?.includes("Saved full-resolution PNG: 96×80"),
    null,
    { timeout: 120000 }
  );

  assert.deepEqual(pageErrors, []);

  console.log(
    `CosmicV Web smoke test passed in ${browserName}: command bar + EdgeCrunch + tabs + full-res export.`
  );
} finally {
  await browser.close();
}
