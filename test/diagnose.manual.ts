// Step-by-step instrumentation of the AI Studio flow, with a screenshot and a state
// report after each action. Use when a generation fails and you need to see where.
import fs from "node:fs/promises";
import { BrowserSession } from "../src/browser.js";
import { config } from "../src/config.js";
import { extractImagesFromText } from "../src/imagebytes.js";
import { sleep } from "../src/queue.js";

const OUT = process.env.DIAG_DIR ?? "/tmp/bb-diag";
await fs.mkdir(OUT, { recursive: true });

const session = new BrowserSession({ headless: true });
const page = await session.page();

const rpcLog: string[] = [];
page.on("response", async (r) => {
  const u = r.url();
  if (!/GenerateContent|generateContent|StreamGenerate/i.test(u)) return;
  let imgs = 0;
  try { imgs = extractImagesFromText(await r.text()).length; } catch { /* body gone */ }
  const line = `${r.status()} imgs=${imgs} ${u.slice(0, 120)}`;
  rpcLog.push(line);
  console.log("  RPC:", line);
});

async function report(step: string) {
  await page.screenshot({ path: `${OUT}/${step}.png` }).catch(() => {});
  const dialog = await page.locator("mat-dialog-container.mdc-dialog--open").first()
    .isVisible({ timeout: 500 }).catch(() => false);
  const busyStop = await page.locator('button[aria-label*="Stop" i]').first()
    .isVisible({ timeout: 500 }).catch(() => false);
  const progress = await page.locator("mat-progress-bar").first()
    .isVisible({ timeout: 500 }).catch(() => false);
  const imgs = await page.locator("img").count().catch(() => -1);
  const big = await page.evaluate(() =>
    Array.from(document.querySelectorAll("img")).filter((i) => i.naturalWidth >= 128).length,
  ).catch(() => -1);
  console.log(`[${step}] dialog=${dialog} stopBtn=${busyStop} progress=${progress} imgs=${imgs} big=${big}`);
  return { dialog };
}

try {
  const url = new URL(config.studioUrl);
  url.searchParams.set("model", config.model);
  await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  await report("1-loaded");

  // Dismiss whatever is up.
  for (let i = 0; i < 3; i++) {
    const x = page.locator("mat-dialog-container button.close-button").first();
    if (await x.isVisible({ timeout: 1000 }).catch(() => false)) {
      console.log("  clicking close-button");
      await x.click({ timeout: 5000 }).catch((e) => console.log("  click failed:", e.message));
      await sleep(1000);
    }
  }
  await report("2-dismissed");

  const input = page.locator("ms-prompt-input-wrapper textarea, textarea").first();
  await input.click();
  await input.type("a single ripe banana on a plain white background, studio photo", { delay: 5 });
  await report("3-typed");

  const run = page.locator('button[aria-label="Run"], ms-run-button button, button:has-text("Run")').first();
  console.log("  run button visible:", await run.isVisible().catch(() => false),
              "enabled:", await run.isEnabled().catch(() => false));
  await run.click({ timeout: 10000 }).catch((e) => console.log("  RUN CLICK FAILED:", e.message));
  await sleep(3000);
  await report("4-after-run");

  for (const t of [10, 20, 40, 70, 100]) {
    await sleep((t - (t === 10 ? 0 : 0)) * 0 + 10000);
    const s = await report(`5-wait-${t}s`);
    if (s.dialog) {
      const x = page.locator("mat-dialog-container button.close-button").first();
      if (await x.isVisible({ timeout: 500 }).catch(() => false)) {
        console.log("  dialog reappeared; closing");
        await x.click({ timeout: 5000 }).catch(() => {});
      }
    }
  }

  const text = await page.locator("ms-chat-turn").last().textContent().catch(() => null);
  console.log("\nlast turn text:", text?.slice(0, 300) ?? "(none)");
  console.log("RPCs seen:", rpcLog.length);
  console.log(`screenshots in ${OUT}`);
} finally {
  await session.close();
}
