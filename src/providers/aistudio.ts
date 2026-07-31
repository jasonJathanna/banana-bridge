import type { Page, Response } from "playwright-core";
import { config } from "../config.js";
import { BananaError } from "../errors.js";
import { BrowserSession, looksLikeSignIn } from "../browser.js";
import { sleep } from "../queue.js";
import {
  anyVisible,
  bySizeDescending,
  dismissDialogs,
  dumpPage,
  findFirst,
  firstPresent,
  harvestDom,
  harvestResponse,
  isRateLimitStatus,
  RATE_LIMIT_TEXT,
  domImageSrcs,
  makeCollector,
  settle,
  truncate,
  type CaptureResult,
  type GenerateRequest,
} from "./shared.js";

/**
 * Google AI Studio (aistudio.google.com).
 *
 * NOTE: on accounts without AI Studio entitlement, clicking Run raises an "Upgrade to
 * unlock more" dialog and no request is ever issued — verified against a live signed-in
 * session for both gemini-2.5-flash-image and gemini-2.5-flash. Those accounts should use
 * the `gemini-app` provider instead. This one is kept for accounts that do have access.
 */

const PROMPT_INPUT = [
  "ms-prompt-input-wrapper textarea",
  'textarea[aria-label*="prompt" i]',
  'textarea[placeholder*="prompt" i]',
  'textarea[placeholder*="Start typing" i]',
  'div[contenteditable="true"][aria-label*="prompt" i]',
  'div[role="textbox"][contenteditable="true"]',
  "textarea",
];

const RUN_BUTTON = [
  'button[aria-label="Run"]',
  "run-button button",
  "ms-run-button button",
  'button:has-text("Run")',
  'button[aria-label*="Send" i]',
];

const BUSY_INDICATOR = [
  'button[aria-label="Stop"]',
  'button[aria-label*="Stop" i]',
  'ms-run-button button:has-text("Stop")',
  "mat-progress-bar",
  "ms-progress-indicator",
];

const DIALOG_CONTAINER = [
  "mat-dialog-container.mdc-dialog--open",
  "ms-upgrade-options-dialog",
  ".cdk-overlay-pane.mat-mdc-dialog-panel",
];

/**
 * Dismissal affordances only — never "Continue with pay per request", "Upgrade" or
 * anything else that could opt the user into billing. A stuck dialog is a reportable
 * error; an accidental purchase is not recoverable.
 */
const DIALOG_DISMISS = [
  "mat-dialog-container button.close-button",
  'mat-dialog-container button[aria-label="close"]',
  'mat-dialog-container button[aria-label*="close" i]',
  '.cdk-overlay-pane button[aria-label*="close" i]',
  'mat-dialog-container button:has-text("No thanks")',
  'mat-dialog-container button:has-text("Not now")',
  'mat-dialog-container button:has-text("Dismiss")',
];

const FILE_INPUT = 'input[type="file"]';
const ADD_ASSET_BUTTON = [
  'button[aria-label*="Insert assets" i]',
  'button[aria-label*="Add" i][aria-label*="file" i]',
  'button[aria-label*="Upload" i]',
  'button[aria-label*="attach" i]',
];

const RESPONSE_TEXT = [
  "ms-chat-turn:last-of-type ms-text-chunk",
  "ms-chat-turn:last-of-type",
  '[data-turn-role="Model"]',
  "ms-model-response",
];

const GENERATE_RPC = /GenerateContent|generateContent|StreamGenerate/i;

export class AiStudioProvider {
  constructor(private readonly session: BrowserSession) {}

  async ensureReady(): Promise<Page> {
    const page = await this.session.page();
    if (!page.url().includes("aistudio.google.com")) {
      await this.openFreshChat(page);
    }
    await this.assertSignedIn(page);
    return page;
  }

  private async openFreshChat(page: Page): Promise<void> {
    const target = new URL(config.studioUrl);
    if (config.model) target.searchParams.set("model", config.model);
    await page.goto(target.toString(), { waitUntil: "domcontentloaded" });
    // The Angular app paints the prompt box well after domcontentloaded. Wait for the
    // box itself — this surface never reaches network idle either.
    await findFirst(page, PROMPT_INPUT, 30_000);
    await settle(page);
  }

  private async assertSignedIn(page: Page): Promise<void> {
    if (looksLikeSignIn(page.url())) {
      throw BananaError.notLoggedIn(await dumpPage(page, "not-logged-in"));
    }
    const input = await findFirst(page, PROMPT_INPUT, 30_000);
    if (!input) {
      const body = (await page.textContent("body").catch(() => "")) ?? "";
      const dumpPath = await dumpPage(page, "no-prompt-input");
      if (/sign in|sign-in|choose an account/i.test(body)) throw BananaError.notLoggedIn(dumpPath);
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

    const { images, collect } = makeCollector();
    let sawRateLimitStatus = false;
    const onResponse = (response: Response) => {
      if (GENERATE_RPC.test(response.url()) && isRateLimitStatus(response.status())) {
        sawRateLimitStatus = true;
      }
      void harvestResponse(response, collect, GENERATE_RPC);
    };
    page.on("response", onResponse);

    // Anything already rendered predates this request; the DOM fallback must not return
    // a previous turn's image as this one's result.
    const preexisting = await domImageSrcs(page);

    try {
      await this.submitPrompt(page, this.composePrompt(request));
      const text = await this.waitForResult(page, images, request.count);

      if (images.length === 0) {
        for (const buf of await harvestDom(page, 256, preexisting)) collect(buf);
      }
      if (images.length === 0) {
        const dumpPath = await dumpPage(page, "no-image");
        if (sawRateLimitStatus || RATE_LIMIT_TEXT.test(text)) {
          throw BananaError.quotaExhaustedRemote(text.trim() || "HTTP 429 from the generate request");
        }
        if (text.trim()) throw BananaError.safetyBlocked(truncate(text, 400));
        throw BananaError.uiChanged("no image found in response or DOM", dumpPath);
      }
      return { images: bySizeDescending(images).slice(0, Math.max(1, request.count)), text };
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

  private async submitPrompt(page: Page, prompt: string): Promise<void> {
    // Upsell modals intercept pointer events on the Run button.
    const stuck = await dismissDialogs(page, DIALOG_CONTAINER, DIALOG_DISMISS);
    if (stuck) throw BananaError.dialogBlocked(stuck, await dumpPage(page, "dialog-blocked"));

    const input = await findFirst(page, PROMPT_INPUT, 30_000);
    if (!input) throw BananaError.uiChanged("prompt input box", await dumpPage(page, "submit"));

    await input.click();
    await input.fill("").catch(() => {});
    // type() rather than fill(): the Angular editor listens for real key events.
    await input.type(prompt, { delay: 4 });
    await this.clickRun(page);
  }

  private async clickRun(page: Page): Promise<void> {
    const run = await findFirst(page, RUN_BUTTON, 5_000);
    if (run && (await run.isEnabled().catch(() => false))) {
      await run.click({ timeout: 10_000 }).catch(async () => {
        // Something is overlaying the button; clear it and try the shortcut.
        await dismissDialogs(page, DIALOG_CONTAINER, DIALOG_DISMISS);
        await page.keyboard.press("Control+Enter");
      });
    } else {
      await page.keyboard.press("Control+Enter");
    }
  }

  private async waitForResult(page: Page, captured: Buffer[], want: number): Promise<string> {
    const deadline = Date.now() + config.timeoutMs;
    let sawBusy = false;
    let settleUntil: number | null = null;
    let rerunsLeft = 1;

    while (Date.now() < deadline) {
      const busy = await anyVisible(page, BUSY_INDICATOR);
      if (busy) sawBusy = true;

      // A modal appearing after Run means the run was intercepted, not slow. Retry once
      // behind a dismissal; if it returns, Google is gating the run and no amount of
      // waiting helps — fail immediately with what the dialog actually said.
      if (captured.length === 0 && !busy) {
        const dialog = await firstPresent(page, DIALOG_CONTAINER);
        if (dialog) {
          const dialogText = ((await dialog.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
          if (rerunsLeft > 0) {
            rerunsLeft--;
            await dismissDialogs(page, DIALOG_CONTAINER, DIALOG_DISMISS);
            await this.clickRun(page);
            await sleep(2_000);
            continue;
          }
          throw BananaError.dialogBlocked(dialogText, await dumpPage(page, "dialog-blocked"));
        }
      }

      if (captured.length > 0) {
        settleUntil ??= Date.now() + (captured.length >= want ? 1_500 : 8_000);
        if (captured.length >= want || Date.now() > settleUntil) break;
      } else if (sawBusy && !busy) {
        await sleep(1_500);
        break;
      }
      await sleep(500);
    }

    if (captured.length === 0 && Date.now() >= deadline) {
      throw BananaError.timeout(config.timeoutMs, await dumpPage(page, "timeout"));
    }
    return await this.readResponseText(page);
  }

  private async readResponseText(page: Page): Promise<string> {
    for (const selector of RESPONSE_TEXT) {
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
      const button = await findFirst(page, ADD_ASSET_BUTTON, 5_000);
      if (!button) throw BananaError.uiChanged("file upload control", await dumpPage(page, "upload"));
      const [chooser] = await Promise.all([page.waitForEvent("filechooser"), button.click()]);
      await chooser.setFiles(paths);
    }
    await settle(page);
    await sleep(1_000);
  }
}
