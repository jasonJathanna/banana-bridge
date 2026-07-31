// Logs URL + size + dims for every image-bearing response during one generation, so the
// real output can be told apart from UI assets.
import { BrowserSession } from "../src/browser.js";
import { config } from "../src/config.js";
import { extractImagesFromText, readDimensions, sniffFormat } from "../src/imagebytes.js";
import { findFirst, firstPresent, settle } from "../src/providers/shared.js";
import { sleep } from "../src/queue.js";

const t0 = Date.now();
const at = () => `t+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const session = new BrowserSession({ headless: true });

try {
  const page = await session.page();
  page.on("response", async (r) => {
    const ct = r.headers()["content-type"] ?? "";
    try {
      if (ct.startsWith("image/") && !/svg/.test(ct)) {
        const b = await r.body();
        if (b.length < 4096 || !sniffFormat(b)) return;
        const d = readDimensions(b);
        console.log(`${at()} IMG  ${Math.round(b.length / 1024)}KB ${d ? d.width + "x" + d.height : "?"}  host=${new URL(r.url()).host}  ${r.url().slice(0, 90)}`);
      } else if (ct.includes("json") || ct.includes("text")) {
        const txt = await r.text();
        for (const b of extractImagesFromText(txt)) {
          const d = readDimensions(b);
          console.log(`${at()} EMB  ${Math.round(b.length / 1024)}KB ${d ? d.width + "x" + d.height : "?"}  host=${new URL(r.url()).host}`);
        }
      }
    } catch { /* body gone */ }
  });

  await page.goto(config.geminiAppUrl, { waitUntil: "domcontentloaded" });
  await findFirst(page, ['rich-textarea div[contenteditable="true"]', 'div[contenteditable="true"]'], 30000);
  await settle(page);
  const notice = await firstPresent(page, ['button:has-text("Got it")']);
  if (notice) { await notice.click().catch(() => {}); console.log(`${at()} dismissed "Got it" notice`); }

  const input = page.locator('rich-textarea div[contenteditable="true"], div[contenteditable="true"]').first();
  await input.click();
  await input.type("Generate an image of a single ripe banana on a plain white background", { delay: 4 });
  await page.keyboard.press("Enter");
  console.log(`${at()} submitted`);

  for (let i = 0; i < 20; i++) {
    await sleep(5000);
    const busy = await firstPresent(page, ['button[aria-label*="Stop" i]', "mat-progress-bar", ".blue-circle-container"]);
    const txt = ((await page.locator("model-response").last().textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
    const big = await page.evaluate(() => Array.from(document.querySelectorAll("img")).filter((im) => im.naturalWidth >= 256).map((im) => `${im.naturalWidth}x${im.naturalHeight}`)).catch(() => []);
    console.log(`${at()} busy=${!!busy} domBig=[${big.join(",")}] text="${txt.slice(0, 60)}"`);
    if (big.length > 0 && !busy) break;
  }
} finally {
  await session.close();
}
