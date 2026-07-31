#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { config } from "./config.js";
import { BrowserSession, looksLikeSignIn } from "./browser.js";
import { createProvider } from "./server.js";
import { describeError } from "./errors.js";
import { quotaStatus } from "./state.js";
import { extractImagesFromText, mimeFor, readDimensions, sniffFormat } from "./imagebytes.js";
import { parseCropSpec, resolveCropRect } from "./crop.js";
import { serve } from "./server.js";
import { sleep } from "./queue.js";

/** The page for the configured provider. */
function surfaceUrl(): string {
  if (config.provider === "aistudio") {
    const url = new URL(config.studioUrl);
    if (config.model) url.searchParams.set("model", config.model);
    return url.toString();
  }
  return config.geminiAppUrl;
}

function log(...args: unknown[]): void {
  console.error(...args);
}

async function waitForEnter(message: string): Promise<void> {
  log(message);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  await new Promise<void>((resolve) => rl.question("", () => resolve()));
  rl.close();
}

/**
 * Interactive, headed sign-in. Deliberately a separate command: an MCP tool call has
 * no way to host a Google login flow, and this process never touches credentials —
 * it just holds a window open until the session cookie exists in the profile.
 */
async function login(): Promise<number> {
  const session = new BrowserSession({ headless: false });
  try {
    const page = await session.page();
    await page.goto(surfaceUrl(), { waitUntil: "domcontentloaded" });

    log("");
    log("A Chrome window is open. Sign in to your Google account and wait for AI Studio to load.");
    log("Use a secondary account: automating this UI is against Google's ToS.");
    log(`Profile dir: ${config.profileDir}`);
    log("");

    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const url = page.isClosed() ? "" : page.url();
      if (!page.isClosed() && !looksLikeSignIn(url) && /aistudio\.google\.com|gemini\.google\.com/.test(url)) {
        const promptBox = page
          .locator('textarea, div[role="textbox"][contenteditable="true"]')
          .first();
        if (await promptBox.isVisible({ timeout: 1_000 }).catch(() => false)) {
          log("Signed in. Session saved to the profile dir — you can close this window.");
          await sleep(1_500);
          return 0;
        }
      }
      if (page.isClosed()) {
        log("Browser window closed before sign-in completed.");
        return 1;
      }
      await sleep(2_000);
    }
    log("Timed out after 10 minutes waiting for sign-in.");
    return 1;
  } finally {
    await session.close();
  }
}

async function doctor(): Promise<number> {
  log("banana-bridge doctor");
  log(`  profile dir : ${config.profileDir}`);
  log(`  output dir  : ${config.outputDir}`);
  log(`  provider    : ${config.provider}`);
  log(`  model       : ${config.model}`);
  log(`  headless    : ${config.headless}`);

  const profileExists = await fs
    .stat(config.profileDir)
    .then(() => true)
    .catch(() => false);
  log(`  profile     : ${profileExists ? "present" : "missing — run `banana-bridge login`"}`);

  const quota = await quotaStatus();
  log(`  quota       : ${quota.used}/${quota.limit} used on ${quota.day} (${quota.remaining} left)`);

  const session = new BrowserSession();
  const provider = createProvider(session);
  try {
    await provider.ensureReady();
    log("  session     : signed in, prompt box reachable");
    return 0;
  } catch (err) {
    const info = describeError(err);
    log(`  session     : FAILED [${info.kind}] ${info.message}`);
    if (info.hint) log(`                ${info.hint}`);
    if (info.debugPath) log(`                debug dump: ${info.debugPath}`);
    return 1;
  } finally {
    await session.close();
  }
}

/**
 * Recon mode. Opens a headed browser and logs every response that carries image
 * bytes while you drive one generation by hand. This is how the capture selectors
 * and RPC matcher get verified against the live UI.
 */
async function recon(): Promise<number> {
  const session = new BrowserSession({ headless: false });
  const logPath = path.join(config.debugDir, `recon-${Date.now()}.log`);
  await fs.mkdir(config.debugDir, { recursive: true });
  const lines: string[] = [];

  try {
    const page = await session.page();
    page.on("response", async (response) => {
      try {
        const url = response.url();
        const contentType = response.headers()["content-type"] ?? "";
        let note = "";
        if (contentType.startsWith("image/")) {
          const body = await response.body();
          const dims = readDimensions(body);
          note = `IMAGE-RESPONSE bytes=${body.length} dims=${dims ? `${dims.width}x${dims.height}` : "?"}`;
        } else if (contentType.includes("json") || contentType.includes("text")) {
          const text = await response.text();
          const found = extractImagesFromText(text);
          if (found.length > 0) {
            note = `EMBEDDED-IMAGES n=${found.length} sizes=${found.map((b) => b.length).join(",")} bodyLen=${text.length}`;
          }
        }
        if (note) {
          const line = `${new Date().toISOString()} ${note}\n  ${url}\n  content-type: ${contentType}`;
          lines.push(line);
          log(line);
        }
      } catch {
        // Ignore bodies we cannot read.
      }
    });

    await page.goto(surfaceUrl(), { waitUntil: "domcontentloaded" });

    log("");
    log("Recon mode. Generate one image by hand in the browser window.");
    log("Every response containing image bytes will be logged here.");
    await waitForEnter("Press Enter when the generation has finished...");

    const html = await page.content().catch(() => "");
    await fs.writeFile(path.join(config.debugDir, `recon-${Date.now()}.html`), html, "utf8");
    await fs.writeFile(logPath, `${lines.join("\n\n")}\n`, "utf8");
    log(`\nWrote ${lines.length} hit(s) to ${logPath}`);
    return 0;
  } finally {
    await session.close();
  }
}


/**
 * Calibration helper for the visible watermark. Writes the same image cropped at a
 * range of bottom insets so you can open them, see which one first clears the mark,
 * and set BANANA_CROP to that value. Beats guessing at pixel offsets.
 */
async function probeWatermark(imagePath: string | undefined): Promise<number> {
  if (!imagePath) {
    log("usage: banana-bridge probe-watermark <image>");
    return 2;
  }
  const source = await fs.readFile(path.resolve(imagePath));
  const format = sniffFormat(source);
  const dims = readDimensions(source);
  if (!format || !dims) {
    log(`Not a readable image: ${imagePath}`);
    return 1;
  }
  log(`${imagePath}: ${dims.width}x${dims.height} ${format}`);

  const outDir = path.join(path.dirname(path.resolve(imagePath)), "watermark-probe");
  await fs.mkdir(outDir, { recursive: true });

  const session = new BrowserSession({ headless: true });
  try {
    for (const pct of [2, 3, 4, 5, 6, 8, 10]) {
      const spec = parseCropSpec(`bottom:${pct}%`)!;
      const rect = resolveCropRect(spec, dims.width, dims.height);
      if (!rect) continue;
      const cropped = await session.cropImage(source, mimeFor(format), rect);
      if (!cropped) {
        log(`  bottom:${pct}% -> crop failed`);
        continue;
      }
      const target = path.join(outDir, `bottom-${pct}pct.png`);
      await fs.writeFile(target, cropped);
      log(`  bottom:${pct}% -> ${rect.width}x${rect.height}  ${target}`);
    }
  } finally {
    await session.close();
  }
  log(`\nOpen the files in ${outDir}, pick the smallest inset with no mark,`);
  log("then set BANANA_CROP (e.g. BANANA_CROP=bottom:4%).");
  return 0;
}

function usage(): void {
  log(`banana-bridge — Gemini image generation over the AI Studio web UI

Usage:
  banana-bridge            Run the MCP server on stdio (default)
  banana-bridge login      One-time interactive Google sign-in
  banana-bridge doctor     Check profile, session and quota
  banana-bridge recon      Log image-bearing responses during a manual generation
  banana-bridge probe-watermark <image>
                           Write test crops to calibrate BANANA_CROP
`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case undefined:
    case "serve":
      await serve();
      return;
    case "login":
      process.exit(await login());
      return;
    case "doctor":
      process.exit(await doctor());
      return;
    case "recon":
      process.exit(await recon());
      return;
    case "probe-watermark":
      process.exit(await probeWatermark(process.argv[3]));
      return;
    default:
      usage();
      process.exit(command === "help" || command === "--help" ? 0 : 2);
  }
}

main().catch((err) => {
  const info = describeError(err);
  log(`fatal [${info.kind}] ${info.message}`);
  if (info.hint) log(info.hint);
  process.exit(1);
});
