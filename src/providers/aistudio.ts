import type { Page, Response } from "playwright-core";
import { config } from "../config.js";
import { BananaError } from "../errors.js";
import { BrowserSession, looksLikeSignIn } from "../browser.js";
import { extractImagesFromText, decodeDataUrl, readDimensions, sniffFormat } from "../imagebytes.js";
import { writeDebugDump } from "../storage.js";
import { sleep } from "../queue.js";

/** Candidate selectors, tried in order. The UI moves; the list absorbs small moves. */
const PROMPT_INPUT = [
  'ms-prompt-input-wrapper textarea',
  'textarea[aria-label*="prompt" i]',
  'textarea[placeholder*="prompt" i]',
  'textarea[placeholder*="Start typing" i]',
  'div[contenteditable="true"][aria-label*="prompt" i]',
  'div[role="textbox"][contenteditable="true"]',
  "textarea",
];

const RUN_BUTTON = [
  'button[aria-label="Run"]',
  'run-button button',
  'ms-run-button button',
  'button:has-text("Run")',
  'button[type="submit"][aria-label*="send" i]',
  'button[aria-label*="Send" i]',
];

/** Presence of any of these means a generation is still in flight. */
const BUSY_INDICATOR = [
  'button[aria-label="Stop"]',
  'button[aria-label*="Stop" i]',
  'ms-run-button button:has-text("Stop")',
  "mat-progress-bar",
  'ms-progress-indicator',
];

/** Modal containers AI Studio throws up (upsells, notices) that block the Run button. */
const DIALOG_CONTAINER = [
  "mat-dialog-container.mdc-dialog--open",
  "ms-upgrade-options-dialog",
  ".cdk-overlay-pane.mat-mdc-dialog-panel",
];

/**
 * Ways out of a blocking dialog. Strictly dismissal affordances — never "Continue with
 * pay per request", "Upgrade", "Subscribe" or anything else that could opt the user
 * into billing. A stuck dialog is a reportable error; an accidental purchase is not
 * recoverable.
 */
const DIALOG_DISMISS = [
  "mat-dialog-container button.close-button",
  'mat-dialog-container button[aria-label="close"]',
  'mat-dialog-container button[aria-label*="close" i]',
  '.cdk-overlay-pane button[aria-label*="close" i]',
  'mat-dialog-container button:has-text("No thanks")',
  'mat-dialog-container button:has-text("Not now")',
  'mat-dialog-container button:has-text("Maybe later")',
  'mat-dialog-container button:has-text("Dismiss")',
];

const FILE_INPUT = 'input[type="file"]';

const ADD_ASSET_BUTTON = [
  'button[aria-label*="Insert assets" i]',
  'button[aria-label*="Add" i][aria-label*="file" i]',
  'button[aria-label*="Upload" i]',
  'button[aria-label*="attach" i]',
];

/** URL fragments belonging to the generate RPC(s) the AI Studio frontend calls. */
const GENERATE_RPC = /GenerateContent|generateContent|StreamGenerate|ResolveDriveResource/i;

export interface GenerateRequest {
  prompt: string;
  count: number;
  aspectRatio?: string;
  imagePaths?: string[];
  reuseConversation?: boolean;
}

export interface CaptureResult {
  images: Buffer[];
  /** Assistant text seen alongside — used to explain an image-less response. */
  text: string;
}

export class AiStudioProvider {
  constructor(private readonly session: BrowserSession) {}

  async ensureReady(): Promise<Page> {
    const page = await this.session.page();
    const url = page.url();
    if (!url.includes("aistudio.google.com")) {
      await this.openFreshChat(page);
    }
    await this.assertSignedIn(page);
    return page;
  }

  private async openFreshChat(page: Page): Promise<void> {
    const target = new URL(config.studioUrl);
    if (config.model) target.searchParams.set("model", config.model);
    await page.goto(target.toString(), { waitUntil: "domcontentloaded" });
    // The Angular app paints the prompt box well after domcontentloaded.
    await page.waitForLoadState("networkidle").catch(() => {});
  }

  private async assertSignedIn(page: Page): Promise<void> {
    if (looksLikeSignIn(page.url())) {
      throw BananaError.notLoggedIn(await this.dump(page, "not-logged-in"));
    }
    const input = await this.findFirst(page, PROMPT_INPUT, 30_000);
    if (!input) {
      // No prompt box and no login URL: either a consent wall or a UI change.
      const body = (await page.textContent("body").catch(() => "")) ?? "";
      const dumpPath = await this.dump(page, "no-prompt-input");
      if (/sign in|sign-in|choose an account/i.test(body)) {
        throw BananaError.notLoggedIn(dumpPath);
      }
      throw BananaError.uiChanged("prompt input box", dumpPath);
    }
  }

  async generate(request: GenerateRequest): Promise<CaptureResult> {
    const page = await this.ensureReady();

    if (!request.reuseConversation) {
      await this.openFreshChat(page);
      await this.assertSignedIn(page);
    }

    if (request.imagePaths?.length) {
      await this.attachFiles(page, request.imagePaths);
    }

    const captured: Buffer[] = [];
    const seen = new Set<string>();
    const collect = (buf: Buffer) => {
      const key = `${buf.length}:${buf.subarray(0, 64).toString("base64")}`;
      if (seen.has(key)) return;
      const dims = readDimensions(buf);
      // Screen out avatars, spinners and logos that share the response stream.
      if (dims && (dims.width < 128 || dims.height < 128)) return;
      seen.add(key);
      captured.push(buf);
    };

    const onResponse = (response: Response) => {
      void this.harvestResponse(response, collect);
    };
    page.on("response", onResponse);

    try {
      await this.submitPrompt(page, this.composePrompt(request));
      const text = await this.waitForResult(page, captured, request.count);
      if (captured.length === 0) {
        // Nothing on the wire — try the rendered DOM before giving up.
        for (const buf of await this.harvestDom(page)) collect(buf);
      }
      if (captured.length === 0) {
        const dumpPath = await this.dump(page, "no-image");
        if (text.trim()) throw BananaError.safetyBlocked(truncate(text, 400));
        throw BananaError.uiChanged("no image found in response or DOM", dumpPath);
      }
      return { images: captured.slice(0, Math.max(1, request.count)), text };
    } finally {
      page.off("response", onResponse);
    }
  }

  private composePrompt(request: GenerateRequest): string {
    const parts = [request.prompt.trim()];
    if (request.aspectRatio) parts.push(`Aspect ratio: ${request.aspectRatio}.`);
    if (request.count > 1) parts.push(`Generate ${request.count} distinct variations as separate images.`);
    return parts.join(" ");
  }

  /** Reads any image bytes out of a network response, whatever the container. */
  private async harvestResponse(response: Response, collect: (buf: Buffer) => void): Promise<void> {
    try {
      const url = response.url();
      const contentType = response.headers()["content-type"] ?? "";

      if (contentType.startsWith("image/") && !/svg/.test(contentType)) {
        const body = await response.body();
        if (body.length >= 4096 && sniffFormat(body)) collect(body);
        return;
      }

      if (!GENERATE_RPC.test(url) && !contentType.includes("json") && !contentType.includes("text")) {
        return;
      }
      const text = await response.text();
      if (text.length < 4096) return;
      for (const buf of extractImagesFromText(text)) collect(buf);
    } catch {
      // Bodies for redirects, aborted requests and preflights are unavailable.
    }
  }

  /** Fallback: pull images straight off the rendered page, including blob: URLs. */
  private async harvestDom(page: Page): Promise<Buffer[]> {
    const encoded = await page
      .evaluate(async () => {
        const out: string[] = [];
        const images = Array.from(document.querySelectorAll("img"));
        for (const img of images) {
          if (img.naturalWidth < 128 || img.naturalHeight < 128) continue;
          const src = img.currentSrc || img.src;
          if (!src) continue;
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
            // Cross-origin or revoked blob; skip it.
          }
        }
        return out;
      })
      .catch(() => [] as string[]);

    const buffers: Buffer[] = [];
    for (const dataUrl of encoded) {
      const buf = decodeDataUrl(dataUrl);
      if (buf) buffers.push(buf);
    }
    return buffers;
  }

  /**
   * Closes any modal sitting over the page. Returns the text of the last dialog it saw,
   * so callers can report *what* was blocking if it will not go away.
   */
  private async dismissDialogs(page: Page, attempts = 3): Promise<string | null> {
    let lastText: string | null = null;

    for (let i = 0; i < attempts; i++) {
      const container = await this.firstPresent(page, DIALOG_CONTAINER);
      if (!container) return null;

      lastText = ((await container.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();

      const dismiss = await this.findFirst(page, DIALOG_DISMISS, 2_000);
      if (dismiss) {
        await dismiss.click({ timeout: 5_000 }).catch(() => {});
      } else {
        // No close control found; Escape is the last non-destructive option.
        await page.keyboard.press("Escape").catch(() => {});
      }
      await sleep(800);
    }

    // Still there after every attempt.
    return (await this.firstPresent(page, DIALOG_CONTAINER)) ? lastText : null;
  }

  private async submitPrompt(page: Page, prompt: string): Promise<void> {
    // Upsell modals intercept pointer events on the Run button.
    const stuck = await this.dismissDialogs(page);
    if (stuck) throw BananaError.dialogBlocked(stuck, await this.dump(page, "dialog-blocked"));

    const input = await this.findFirst(page, PROMPT_INPUT, 30_000);
    if (!input) throw BananaError.uiChanged("prompt input box", await this.dump(page, "submit"));

    await input.click();
    await input.fill("").catch(() => {});
    // type() rather than fill(): the Angular editor listens for real key events.
    await input.type(prompt, { delay: 4 });

    await this.clickRun(page);
  }

  private async clickRun(page: Page): Promise<void> {
    const run = await this.findFirst(page, RUN_BUTTON, 5_000);
    if (run && (await run.isEnabled().catch(() => false))) {
      await run.click({ timeout: 10_000 }).catch(async () => {
        // Something is overlaying the button; clear it and try the shortcut.
        await this.dismissDialogs(page);
        await page.keyboard.press("Control+Enter");
      });
    } else {
      await page.keyboard.press("Control+Enter");
    }
  }

  /**
   * Polls until images arrive, the busy indicator clears, or the deadline passes.
   * Returns whatever assistant text is on screen, which is the only explanation
   * available when a prompt is refused.
   */
  private async waitForResult(page: Page, captured: Buffer[], want: number): Promise<string> {
    const deadline = Date.now() + config.timeoutMs;
    let sawBusy = false;
    let settleUntil: number | null = null;
    let rerunsLeft = 1;

    while (Date.now() < deadline) {
      const busy = await this.anyVisible(page, BUSY_INDICATOR);
      if (busy) sawBusy = true;

      // A modal appearing after Run means the run was intercepted, not slow. Retry once
      // behind a dismissal; if it comes back, Google is gating the run and no amount of
      // waiting will help — fail immediately with what the dialog actually said.
      if (captured.length === 0 && !busy) {
        const dialog = await this.firstPresent(page, DIALOG_CONTAINER);
        if (dialog) {
          const dialogText = ((await dialog.textContent().catch(() => "")) ?? "")
            .replace(/\s+/g, " ")
            .trim();
          if (rerunsLeft > 0) {
            rerunsLeft--;
            await this.dismissDialogs(page);
            await this.clickRun(page);
            await sleep(2_000);
            continue;
          }
          throw BananaError.dialogBlocked(dialogText, await this.dump(page, "dialog-blocked"));
        }
      }

      if (captured.length > 0) {
        // Give slower variations a moment to land before returning.
        settleUntil ??= Date.now() + (captured.length >= want ? 1_500 : 8_000);
        if (captured.length >= want || Date.now() > settleUntil) break;
      } else if (sawBusy && !busy) {
        // Run finished with nothing captured — stop waiting, let the caller
        // decide between refusal and UI change.
        await sleep(1_500);
        break;
      }

      await sleep(500);
    }

    if (captured.length === 0 && Date.now() >= deadline) {
      throw BananaError.timeout(config.timeoutMs, await this.dump(page, "timeout"));
    }
    return await this.readAssistantText(page);
  }

  private async readAssistantText(page: Page): Promise<string> {
    const selectors = [
      "ms-chat-turn:last-of-type ms-text-chunk",
      "ms-chat-turn:last-of-type",
      '[data-turn-role="Model"]',
      "ms-model-response",
    ];
    for (const selector of selectors) {
      const text = await page
        .locator(selector)
        .last()
        .textContent({ timeout: 2_000 })
        .catch(() => null);
      if (text && text.trim()) return text.trim();
    }
    return "";
  }

  private async attachFiles(page: Page, paths: string[]): Promise<void> {
    const direct = page.locator(FILE_INPUT).first();
    if ((await direct.count()) > 0) {
      await direct.setInputFiles(paths);
    } else {
      const button = await this.findFirst(page, ADD_ASSET_BUTTON, 5_000);
      if (!button) throw BananaError.uiChanged("file upload control", await this.dump(page, "upload"));
      const [chooser] = await Promise.all([page.waitForEvent("filechooser"), button.click()]);
      await chooser.setFiles(paths);
    }
    // Uploads must finish before the run, or they are silently dropped.
    await page.waitForLoadState("networkidle").catch(() => {});
    await sleep(1_000);
  }

  private async findFirst(page: Page, selectors: string[], timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    do {
      for (const selector of selectors) {
        const locator = page.locator(selector).first();
        if (await locator.isVisible({ timeout: 500 }).catch(() => false)) return locator;
      }
      await sleep(400);
    } while (Date.now() < deadline);
    return null;
  }

  /** Like findFirst but single-shot and visibility-checked, for transient overlays. */
  private async firstPresent(page: Page, selectors: string[]) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible({ timeout: 300 }).catch(() => false)) return locator;
    }
    return null;
  }

  private async anyVisible(page: Page, selectors: string[]): Promise<boolean> {
    for (const selector of selectors) {
      if (await page.locator(selector).first().isVisible({ timeout: 200 }).catch(() => false)) return true;
    }
    return false;
  }

  private async dump(page: Page, label: string): Promise<string | undefined> {
    try {
      return await writeDebugDump(label, {
        screenshot: await page.screenshot({ fullPage: false }).catch(() => undefined),
        html: await page.content().catch(() => undefined),
        notes: `url: ${page.url()}\nmodel: ${config.model}\n`,
      });
    } catch {
      return undefined;
    }
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
