import type { Page } from "playwright-core";
import { config } from "../config.js";
import { BananaError } from "../errors.js";
import { BrowserSession, looksLikeSignIn } from "../browser.js";
import fs from "node:fs/promises";
import path from "node:path";
import { sleep } from "../queue.js";
import { mimeFor, sniffFormat } from "../imagebytes.js";
import {
  anyVisible,
  bySizeDescending,
  dismissDialogs,
  dumpPage,
  findFirst,
  firstPresent,
  harvestDom,
  harvestResponse,
  makeCollector,
  settle,
  truncate,
  type CaptureResult,
  type GenerateRequest,
} from "./shared.js";

/**
 * The consumer Gemini app (gemini.google.com).
 *
 * Unlike AI Studio — which gates Run behind a billing dialog on free accounts — this
 * surface generates images for an ordinary signed-in Google account. The tradeoff is
 * that it stamps a visible sparkle watermark into the result, which is what the `crop`
 * option is for.
 */

const PROMPT_INPUT = [
  'rich-textarea div[contenteditable="true"]',
  'div[contenteditable="true"][role="textbox"]',
  'div[contenteditable="true"]',
  "textarea",
];

const SEND_BUTTON = [
  'button[aria-label*="Send" i]',
  'button[aria-label*="Submit" i]',
  'button:has(mat-icon[fonticon="send"])',
];

/** Present while a response is streaming. */
const BUSY_INDICATOR = [
  'button[aria-label*="Stop" i]',
  'button[aria-label*="stop response" i]',
  "mat-progress-bar",
  ".blue-circle-container",
];

const DIALOG_CONTAINER = ["mat-dialog-container.mdc-dialog--open", ".cdk-overlay-pane.mat-mdc-dialog-panel"];

/**
 * Dismissal only — never anything resembling an upgrade or purchase. Deliberately no
 * "Continue" entry: on these surfaces that text belongs to billing flows
 * ("Continue with pay per request"), not to notices.
 */
const DIALOG_DISMISS = [
  'mat-dialog-container button:has-text("Got it")',
  'mat-dialog-container button:has-text("No thanks")',
  'mat-dialog-container button:has-text("Not now")',
  'mat-dialog-container button:has-text("Dismiss")',
  'mat-dialog-container button[aria-label*="close" i]',
  '.cdk-overlay-pane button[aria-label*="close" i]',
];

/**
 * Gemini's "Keep in mind" notice is NOT a Material dialog — it sits outside
 * mat-dialog-container and .cdk-overlay-pane entirely, so the dialog selectors above
 * never match it (measured: gotIt=1 while matDialogAny=0). It can still overlay the
 * send button, so it gets dismissed separately by button text.
 */
const NOTICE_DISMISS = [
  'button:has-text("Got it")',
  'button:has-text("No thanks")',
  'button:has-text("Not now")',
  'button:has-text("Dismiss")',
];

const NEW_CHAT = ['button[aria-label*="New chat" i]', 'a[aria-label*="New chat" i]', 'button:has-text("New chat")'];

const FILE_INPUT = 'input[type="file"]';

/**
 * Uploading is two steps here, not one: this button opens a MENU (observed items:
 * "Upload files", "Add from Drive", "Create image", …) and only the menu item raises
 * the file chooser. Waiting for a chooser on this click hangs until the timeout.
 */
const ADD_FILE_BUTTON = [
  'button[aria-label*="Upload & tools" i]',
  'button[aria-label*="Open upload file menu" i]',
  'button[aria-label*="add files" i]',
  'button[aria-label*="Upload" i]',
  'button[aria-label*="attach" i]',
];

const UPLOAD_MENU_ITEM = [
  '[role="menuitem"]:has-text("Upload files")',
  'button:has-text("Upload files")',
  '.mat-mdc-menu-item:has-text("Upload files")',
  '[role="menuitem"]:has-text("Upload")',
];

const RESPONSE_TEXT = ["model-response message-content", "model-response", "message-content"];

/** Evidence that the composer really holds an attachment, not just that we tried. */
const ATTACHMENT_INDICATOR = [
  'button[aria-label*="Remove" i]',
  'button[aria-label*="Delete file" i]',
  "uploader-file-preview",
  '[data-test-id*="file"]',
  ".file-preview",
];

/** Gemini's streaming RPC. Matching is a hint only; capture is content-sniffed. */
const GENERATE_RPC = /StreamGenerate|BardFrontendService|batchexecute|assistant\.lamda/i;

/** The app needs to be told this is an image request, not a question about one. */
const IMAGE_INTENT = /\b(image|picture|photo|photograph|drawing|illustration|render|logo|artwork)\b/i;

export class GeminiAppProvider {
  constructor(private readonly session: BrowserSession) {}

  async ensureReady(): Promise<Page> {
    const page = await this.session.page();
    if (!page.url().includes("gemini.google.com")) {
      await this.open(page);
    }
    await this.assertSignedIn(page);
    return page;
  }

  private async open(page: Page): Promise<void> {
    await page.goto(config.geminiAppUrl, { waitUntil: "domcontentloaded" });
    // Wait for the thing we actually need rather than for the network to go quiet.
    await findFirst(page, PROMPT_INPUT, 30_000);
    await settle(page);
    await this.clearOverlays(page);
  }

  /** Clears both Material dialogs and the non-dialog "Keep in mind" notice. */
  private async clearOverlays(page: Page): Promise<string | null> {
    const notice = await firstPresent(page, NOTICE_DISMISS);
    if (notice) {
      await notice.click({ timeout: 5_000 }).catch(() => {});
      await sleep(500);
    }
    return await dismissDialogs(page, DIALOG_CONTAINER, DIALOG_DISMISS);
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
      throw BananaError.uiChanged("Gemini prompt box", dumpPath);
    }
  }

  async generate(request: GenerateRequest): Promise<CaptureResult> {
    const page = await this.ensureReady();

    if (!request.reuseConversation) {
      await this.startNewChat(page);
    }
    if (request.imagePaths?.length) {
      await this.attachFiles(page, request.imagePaths);
    }

    const { images, collect } = makeCollector();
    const onResponse = (response: import("playwright-core").Response) => {
      void harvestResponse(response, collect, GENERATE_RPC);
    };
    page.on("response", onResponse);

    try {
      await this.submit(page, this.composePrompt(request));
      const text = await this.waitForResult(page, images, request.count);

      if (images.length === 0) {
        for (const buf of await harvestDom(page)) collect(buf);
      }
      if (images.length === 0) {
        const dumpPath = await dumpPage(page, "no-image");
        if (text.trim()) throw BananaError.safetyBlocked(truncate(text, 400));
        throw BananaError.uiChanged("no image found in response or DOM", dumpPath);
      }

      // Largest first: the generated image dwarfs any UI asset that slipped through.
      return { images: bySizeDescending(images).slice(0, Math.max(1, request.count)), text };
    } finally {
      page.off("response", onResponse);
    }
  }

  /**
   * A fresh conversation per request, so a previous image is never mistaken for this
   * one and prior context does not steer the result.
   */
  private async startNewChat(page: Page): Promise<void> {
    const button = await firstPresent(page, NEW_CHAT);
    if (button) {
      await button.click({ timeout: 10_000 }).catch(() => {});
      await sleep(1_500);
    } else {
      await this.open(page);
    }
    await this.clearOverlays(page);
  }

  private composePrompt(request: GenerateRequest): string {
    const prompt = request.prompt.trim();
    const parts: string[] = [];

    // Without an explicit instruction the app answers *about* the subject instead of
    // drawing it. Only add one when the prompt does not already imply an image.
    parts.push(IMAGE_INTENT.test(prompt) ? prompt : `Generate an image of ${prompt}`);
    if (request.aspectRatio) parts.push(`Use a ${request.aspectRatio} aspect ratio.`);
    if (request.count > 1) parts.push(`Produce ${request.count} distinct variations.`);
    return parts.join(" ");
  }

  private async submit(page: Page, prompt: string): Promise<void> {
    const stuck = await this.clearOverlays(page);
    if (stuck) throw BananaError.dialogBlocked(stuck, await dumpPage(page, "dialog-blocked"));

    const input = await findFirst(page, PROMPT_INPUT, 30_000);
    if (!input) throw BananaError.uiChanged("Gemini prompt box", await dumpPage(page, "submit"));

    await input.click();
    // The editor is a contenteditable that listens for real key events.
    await input.type(prompt, { delay: 4 });
    await sleep(400);

    const send = await firstPresent(page, SEND_BUTTON);
    if (send && (await send.isEnabled().catch(() => false))) {
      await send.click({ timeout: 10_000 }).catch(() => page.keyboard.press("Enter"));
    } else {
      await page.keyboard.press("Enter");
    }
  }

  private async waitForResult(page: Page, captured: Buffer[], want: number): Promise<string> {
    const deadline = Date.now() + config.timeoutMs;
    let sawBusy = false;
    let settleUntil: number | null = null;

    while (Date.now() < deadline) {
      const busy = await anyVisible(page, BUSY_INDICATOR);

      // Never accept while the response is still streaming: assets that load early
      // would otherwise satisfy the count and end the wait before the real image
      // arrives (measured: image lands ~15s in, well after page chrome).
      if (busy) {
        sawBusy = true;
        settleUntil = null;
        await sleep(500);
        continue;
      }

      if (captured.length > 0) {
        settleUntil ??= Date.now() + (captured.length >= want ? 2_000 : 8_000);
        if (captured.length >= want || Date.now() > settleUntil) break;
      } else if (sawBusy) {
        // Response finished with no image: a refusal or a text-only answer.
        await sleep(2_000);
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

  /**
   * Attaches local images to the composer.
   *
   * The obvious route — click "Upload & tools" then "Upload files" — is NOT automatable:
   * that menu item opens a native OS picker through the File System Access API, which
   * injects no <input type=file> and raises no Playwright "filechooser" event, so any
   * wait on one hangs until it times out. Synthesising a drop carries the bytes in
   * without involving a native dialog at all.
   */
  private async attachFiles(page: Page, paths: string[]): Promise<void> {
    // Still prefer a real input if the page ever exposes one.
    if ((await page.locator(FILE_INPUT).count()) > 0) {
      await page.locator(FILE_INPUT).first().setInputFiles(paths);
      await settle(page);
      await sleep(3_000);
      return;
    }

    const files: { name: string; mime: string; base64: string }[] = [];
    for (const p of paths) {
      const bytes = await fs.readFile(p);
      const format = sniffFormat(bytes);
      if (!format) throw BananaError.invalidInput(`Not a readable image: ${p}`);
      files.push({ name: path.basename(p), mime: mimeFor(format), base64: bytes.toString("base64") });
    }

    const target = await findFirst(page, PROMPT_INPUT, 15_000);
    if (!target) throw BananaError.uiChanged("composer for file drop", await dumpPage(page, "upload"));

    const built = await target.evaluate((el, files) => {
      const dt = new DataTransfer();
      for (const f of files) {
        const bin = atob(f.base64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        dt.items.add(new File([arr], f.name, { type: f.mime }));
      }
      const opts = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt };
      const node = (el as HTMLElement).closest("rich-textarea") ?? (el as HTMLElement);
      node.dispatchEvent(new DragEvent("dragenter", opts));
      node.dispatchEvent(new DragEvent("dragover", opts));
      node.dispatchEvent(new DragEvent("drop", opts));
      return dt.files.length;
    }, files);

    void built; // Building a DataTransfer proves nothing; only the UI can confirm.

    // Verify the app actually ingested the file. Without this check a failed attach
    // silently degrades into a plain text-to-image generation, which returns a
    // confident-looking result that has nothing to do with the input image.
    await settle(page);
    const attached = await findFirst(page, ATTACHMENT_INDICATOR, 8_000);
    if (!attached) {
      throw BananaError.uploadUnsupported(await dumpPage(page, "upload-unsupported"));
    }
    await sleep(3_000);
  }
}
