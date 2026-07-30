import fs from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { config } from "./config.js";
import type { CropRect } from "./crop.js";
import { BananaError } from "./errors.js";

const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-default-browser-check",
  "--no-first-run",
  "--disable-features=Translate,MediaRouter",
];

export interface LaunchOptions {
  headless?: boolean;
}

/**
 * One long-lived persistent context for the process. The profile dir carries the
 * Google session established by `banana-bridge login`, so nothing here ever handles
 * credentials itself.
 */
export class BrowserSession {
  #context: BrowserContext | null = null;
  #page: Page | null = null;

  constructor(private readonly options: LaunchOptions = {}) {}

  get isOpen(): boolean {
    return this.#context !== null;
  }

  async context(): Promise<BrowserContext> {
    if (this.#context) return this.#context;

    await fs.mkdir(config.profileDir, { recursive: true });
    const headless = this.options.headless ?? config.headless;

    try {
      this.#context = await chromium.launchPersistentContext(config.profileDir, {
        headless,
        channel: config.executablePath ? undefined : config.browserChannel,
        executablePath: config.executablePath,
        args: LAUNCH_ARGS,
        viewport: { width: 1440, height: 900 },
        acceptDownloads: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BananaError(
        "browser_unavailable",
        `Could not launch Chrome: ${message}`,
        "Install Google Chrome, or set BANANA_CHROME_PATH / BANANA_BROWSER_CHANNEL to a browser you have.",
      );
    }

    this.#context.setDefaultTimeout(config.timeoutMs);
    this.#context.setDefaultNavigationTimeout(config.navTimeoutMs);
    return this.#context;
  }

  /** The single working tab, reused across jobs. */
  async page(): Promise<Page> {
    const context = await this.context();
    if (this.#page && !this.#page.isClosed()) return this.#page;
    const existing = context.pages().find((p) => !p.isClosed());
    this.#page = existing ?? (await context.newPage());
    return this.#page;
  }

  /**
   * Runs a canvas operation on an image in a throwaway blank page. Using the browser
   * we already have avoids a native image dependency entirely.
   */
  async #onBlankPage<T>(run: (page: Page) => Promise<T>): Promise<T> {
    const context = await this.context();
    const page = await context.newPage();
    try {
      await page.goto("about:blank");
      return await run(page);
    } finally {
      await page.close();
    }
  }

  /**
   * Resizes an image down so the MCP preview stays small.
   * Returns base64 JPEG, or null on any failure — a preview is cosmetic.
   */
  async makePreview(buf: Buffer, mimeType: string, maxDim = 512, quality = 0.7): Promise<string | null> {
    try {
      return await this.#onBlankPage((page) =>
        page.evaluate(
          async ({ dataUrl, maxDim, quality }) => {
            const blob = await (await fetch(dataUrl)).blob();
            const bitmap = await createImageBitmap(blob);
            const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
            const w = Math.max(1, Math.round(bitmap.width * scale));
            const h = Math.max(1, Math.round(bitmap.height * scale));
            const canvas = new OffscreenCanvas(w, h);
            const ctx = canvas.getContext("2d");
            if (!ctx) return null;
            ctx.drawImage(bitmap, 0, 0, w, h);
            const out = await canvas.convertToBlob({ type: "image/jpeg", quality });
            const arr = new Uint8Array(await out.arrayBuffer());
            let binary = "";
            for (const byte of arr) binary += String.fromCharCode(byte);
            return btoa(binary);
          },
          { dataUrl: toDataUrl(buf, mimeType), maxDim, quality },
        ),
      );
    } catch {
      return null;
    }
  }

  /**
   * Crops to the given rect and re-encodes as PNG — lossless, so trimming a
   * watermark strip costs nothing in image quality even on a JPEG source.
   * Returns null on failure so the caller can keep the uncropped original.
   */
  async cropImage(buf: Buffer, mimeType: string, rect: CropRect): Promise<Buffer | null> {
    try {
      const encoded = await this.#onBlankPage((page) =>
        page.evaluate(
          async ({ dataUrl, x, y, width, height }) => {
            const blob = await (await fetch(dataUrl)).blob();
            const bitmap = await createImageBitmap(blob);
            if (x + width > bitmap.width || y + height > bitmap.height) return null;
            const canvas = new OffscreenCanvas(width, height);
            const ctx = canvas.getContext("2d");
            if (!ctx) return null;
            ctx.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
            const out = await canvas.convertToBlob({ type: "image/png" });
            const arr = new Uint8Array(await out.arrayBuffer());
            let binary = "";
            for (const byte of arr) binary += String.fromCharCode(byte);
            return btoa(binary);
          },
          { dataUrl: toDataUrl(buf, mimeType), ...rect },
        ),
      );
      return encoded ? Buffer.from(encoded, "base64") : null;
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    const context = this.#context;
    this.#context = null;
    this.#page = null;
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

function toDataUrl(buf: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buf.toString("base64")}`;
}

/** True when the page is sitting on a Google sign-in / consent flow. */
export function looksLikeSignIn(url: string): boolean {
  return /accounts\.google\.com|\/ServiceLogin|signin\/v2|gds\.google\.com\/web\/signin/.test(url);
}
