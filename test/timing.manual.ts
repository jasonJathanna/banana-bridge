// Times each step the gemini-app provider performs, to find where a generation stalls.
import { BrowserSession } from "../src/browser.js";
import { config } from "../src/config.js";
import { sleep } from "../src/queue.js";

const t0 = Date.now();
const mark = (s: string) => console.log(`  t+${((Date.now() - t0) / 1000).toFixed(1)}s  ${s}`);

const session = new BrowserSession({ headless: true });
try {
  const page = await session.page();
  mark("browser launched");

  await page.goto(config.geminiAppUrl, { waitUntil: "domcontentloaded" });
  mark("goto domcontentloaded");

  // PRIME SUSPECT: a chat app that polls may never reach network idle.
  const idleStart = Date.now();
  let idleOk = true;
  await page.waitForLoadState("networkidle").catch(() => { idleOk = false; });
  mark(`waitForLoadState(networkidle) -> ${idleOk ? "settled" : "TIMED OUT"} after ${((Date.now() - idleStart) / 1000).toFixed(1)}s`);

  console.log("  signed in:", !/accounts\.google\.com/.test(page.url()));

  // What overlays actually exist?
  const overlays = await page.evaluate(() => ({
    matDialogOpen: document.querySelectorAll("mat-dialog-container.mdc-dialog--open").length,
    matDialogAny: document.querySelectorAll("mat-dialog-container").length,
    cdkPanes: document.querySelectorAll(".cdk-overlay-pane").length,
    cdkDialogPanes: document.querySelectorAll(".cdk-overlay-pane.mat-mdc-dialog-panel").length,
    gotIt: Array.from(document.querySelectorAll("button")).filter((b) => /got it/i.test(b.textContent ?? "")).length,
    continueBtns: Array.from(document.querySelectorAll("button")).filter((b) => /continue/i.test(b.textContent ?? "")).length,
    newChat: document.querySelectorAll('button[aria-label*="New chat" i], a[aria-label*="New chat" i]').length,
    editable: document.querySelectorAll('div[contenteditable="true"]').length,
    sendBtns: document.querySelectorAll('button[aria-label*="Send" i], button[aria-label*="Submit" i]').length,
  }));
  console.log("  overlays/controls:", JSON.stringify(overlays));
  mark("overlay probe");

  // Time the busy-indicator poll the provider uses.
  const busySel = ['button[aria-label*="Stop" i]', 'button[aria-label*="stop response" i]', "mat-progress-bar", ".blue-circle-container"];
  const bStart = Date.now();
  for (const s of busySel) {
    const vis = await page.locator(s).first().isVisible({ timeout: 300 }).catch(() => false);
    console.log(`    busy "${s}" -> ${vis}`);
  }
  mark(`busy probe (${((Date.now() - bStart) / 1000).toFixed(1)}s)`);

  await sleep(500);
  console.log(`\nconfig: navTimeoutMs=${config.navTimeoutMs} timeoutMs=${config.timeoutMs} provider=${config.provider}`);
} finally {
  await session.close();
  mark("closed");
}
