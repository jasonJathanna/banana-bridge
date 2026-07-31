import type { Locator, Page, Response } from "playwright-core";
import { config } from "../config.js";
import { decodeDataUrl, extractImagesFromText, readDimensions, sniffFormat } from "../imagebytes.js";
import { writeDebugDump } from "../storage.js";
import { sleep } from "../queue.js";

/**
 * Capture and DOM plumbing shared by every browser-driven provider. The surfaces differ
 * in selectors and navigation; how bytes are recovered is identical.
 */

export interface GenerateRequest {
  prompt: string;
  count: number;
  aspectRatio?: string;
  imagePaths?: string[];
  reuseConversation?: boolean;
}

export interface CaptureResult {
  images: Buffer[];
  /** Assistant text seen alongside — the only explanation when no image comes back. */
  text: string;
}

/**
 * Accumulates images, deduped by content, discarding anything too small to be a
 * generated result (avatars, spinners, logos ride along in the same responses).
 */
export function makeCollector(minDim = 128): { images: Buffer[]; collect: (buf: Buffer) => void } {
  const images: Buffer[] = [];
  const seen = new Set<string>();
  return {
    images,
    collect(buf: Buffer) {
      const key = `${buf.length}:${buf.subarray(0, 64).toString("base64")}`;
      if (seen.has(key)) return;
      const dims = readDimensions(buf);
      if (dims && (dims.width < minDim || dims.height < minDim)) return;
      seen.add(key);
      images.push(buf);
    },
  };
}

/** Largest first — the generated image outweighs UI chrome that slips past the filter. */
export function bySizeDescending(images: Buffer[]): Buffer[] {
  return [...images].sort((a, b) => {
    const da = readDimensions(a);
    const db = readDimensions(b);
    const areaA = da ? da.width * da.height : 0;
    const areaB = db ? db.width * db.height : 0;
    return areaB - areaA || b.length - a.length;
  });
}

/**
 * Hosts that only ever serve UI chrome. Measured on gemini.google.com: the 512x512
 * "gemini_sparkle" logo and a 106x6138 sprite sheet both arrive from gstatic and both
 * clear the size filter, so without this the logo gets saved as the generated image.
 */
const ASSET_HOST = /(^|\.)gstatic\.com$/i;

/** Reads image bytes out of a network response, whatever container they arrive in. */
export async function harvestResponse(
  response: Response,
  collect: (buf: Buffer) => void,
  rpcPattern: RegExp,
): Promise<void> {
  try {
    const contentType = response.headers()["content-type"] ?? "";

    let host = "";
    try {
      host = new URL(response.url()).host;
    } catch {
      // blob: and data: URLs have no host; those are page-generated, so keep them.
    }
    if (host && ASSET_HOST.test(host)) return;

    if (contentType.startsWith("image/") && !/svg/.test(contentType)) {
      const body = await response.body();
      if (body.length >= 4096 && sniffFormat(body)) collect(body);
      return;
    }

    if (!rpcPattern.test(response.url()) && !contentType.includes("json") && !contentType.includes("text")) {
      return;
    }
    const text = await response.text();
    if (text.length < 4096) return;
    for (const buf of extractImagesFromText(text)) collect(buf);
  } catch {
    // Redirects, aborted requests and preflights have no readable body.
  }
}

/**
 * The srcs of large images already on the page. Snapshot this BEFORE submitting so the
 * DOM fallback can ignore them: the page legitimately holds a previous turn's result and
 * the preview of a just-uploaded input, either of which would otherwise be returned as
 * this request's output.
 */
export async function domImageSrcs(page: Page, minDim = 256): Promise<string[]> {
  return await page
    .evaluate(
      (minDim) =>
        Array.from(document.querySelectorAll("img"))
          .filter((img) => img.naturalWidth >= minDim && img.naturalHeight >= minDim)
          .map((img) => img.currentSrc || img.src)
          .filter(Boolean),
      minDim,
    )
    .catch(() => [] as string[]);
}

/** Fallback: pull images off the rendered page, resolving blob: URLs in page context. */
export async function harvestDom(page: Page, minDim = 256, exclude: string[] = []): Promise<Buffer[]> {
  const encoded = await page
    .evaluate(async ({ minDim, exclude }) => {
      const skip = new Set(exclude);
      const out: string[] = [];
      for (const img of Array.from(document.querySelectorAll("img"))) {
        if (img.naturalWidth < minDim || img.naturalHeight < minDim) continue;
        const src = img.currentSrc || img.src;
        if (!src || skip.has(src)) continue;
        if (src.startsWith("data:")) {
          out.push(src);
          continue;
        }
        try {
          const blob = await (await fetch(src)).blob();
          if (!blob.type.startsWith("image/") || blob.size < 4096) continue;
          const arr = new Uint8Array(await blob.arrayBuffer());
          let binary = "";
          for (const byte of arr) binary += String.fromCharCode(byte);
          out.push(`data:${blob.type};base64,${btoa(binary)}`);
        } catch {
          // Cross-origin or revoked blob.
        }
      }
      return out;
    }, { minDim, exclude })
    .catch(() => [] as string[]);

  const buffers: Buffer[] = [];
  for (const dataUrl of encoded) {
    // A malformed src must never abort the generation; this is a best-effort fallback.
    try {
      const buf = decodeDataUrl(dataUrl);
      if (buf) buffers.push(buf);
    } catch {
      // Skip this one.
    }
  }
  return buffers;
}

/** Polls a candidate list until one is visible, so small UI moves don't break us. */
export async function findFirst(page: Page, selectors: string[], timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    const hit = await firstPresent(page, selectors);
    if (hit) return hit;
    await sleep(400);
  } while (Date.now() < deadline);
  return null;
}

/** Single-shot visibility check, for transient overlays. */
export async function firstPresent(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible({ timeout: 300 }).catch(() => false)) return locator;
  }
  return null;
}

export async function anyVisible(page: Page, selectors: string[]): Promise<boolean> {
  return (await firstPresent(page, selectors)) !== null;
}

/**
 * Clicks through dismissal affordances until no modal remains. Returns the blocking
 * dialog's text if one survives, so the caller can report what stopped it.
 *
 * Only ever clicks dismissal controls. Never anything that could enable billing.
 */
export async function dismissDialogs(
  page: Page,
  containers: string[],
  dismissals: string[],
  attempts = 3,
): Promise<string | null> {
  let lastText: string | null = null;

  for (let i = 0; i < attempts; i++) {
    const container = await firstPresent(page, containers);
    if (!container) return null;
    lastText = ((await container.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();

    const dismiss = await firstPresent(page, dismissals);
    if (dismiss) await dismiss.click({ timeout: 5_000 }).catch(() => {});
    else await page.keyboard.press("Escape").catch(() => {});
    await sleep(800);
  }

  return (await firstPresent(page, containers)) ? lastText : null;
}

/**
 * Bounded "settled enough" wait.
 *
 * NEVER use bare waitForLoadState("networkidle") on these surfaces: Gemini and AI Studio
 * poll continuously and never reach network idle, so an unbounded call burns the whole
 * navigation timeout (measured: a guaranteed 60s per call) on every navigation.
 */
export async function settle(page: Page, ms = 2_500): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: ms }).catch(() => {});
}

export async function dumpPage(page: Page, label: string, extra = ""): Promise<string | undefined> {
  try {
    return await writeDebugDump(label, {
      screenshot: await page.screenshot({ fullPage: false }).catch(() => undefined),
      html: await page.content().catch(() => undefined),
      notes: `url: ${page.url()}\nprovider: ${config.provider}\nmodel: ${config.model}\n${extra}`,
    });
  } catch {
    return undefined;
  }
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
