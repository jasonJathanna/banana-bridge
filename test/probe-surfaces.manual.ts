// (a) enumerate every actionable control in the AI Studio gate dialog, looking for a
// free/dismiss path I might have missed; (b) check whether gemini.google.com — the
// consumer app — will generate for this same signed-in profile.
import { BrowserSession } from "../src/browser.js";
import { config } from "../src/config.js";
import { extractImagesFromText, readDimensions } from "../src/imagebytes.js";
import { sleep } from "../src/queue.js";

const session = new BrowserSession({ headless: true });

try {
  // ---------- (a) AI Studio gate dialog ----------
  console.log("=== A: AI Studio gate dialog ===");
  const page = await session.page();
  const u = new URL(config.studioUrl);
  u.searchParams.set("model", config.model);
  await page.goto(u.toString(), { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  const input = page.locator("ms-prompt-input-wrapper textarea, textarea").first();
  await input.click();
  await input.type("test", { delay: 5 });
  await page.locator('button[aria-label="Run"], ms-run-button button, button:has-text("Run")').first()
    .click({ timeout: 10000 }).catch((e) => console.log("run click:", e.message));
  await sleep(4000);

  const dlg = page.locator("mat-dialog-container").first();
  if (await dlg.isVisible({ timeout: 2000 }).catch(() => false)) {
    const controls = await dlg.evaluate((el) =>
      Array.from(el.querySelectorAll("button, a, [role=button], input")).map((c) => ({
        tag: c.tagName.toLowerCase(),
        text: (c.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
        aria: c.getAttribute("aria-label"),
        href: c.getAttribute("href"),
      })),
    );
    console.log("dialog controls:");
    for (const c of controls) console.log("  ", JSON.stringify(c));
    const full = ((await dlg.textContent()) ?? "").replace(/\s+/g, " ").trim();
    console.log("\nfull dialog text:\n", full.slice(0, 1200));
    console.log("\nmentions free tier?", /free/i.test(full));
    console.log("mentions region?", /region|country|not available|unavailable/i.test(full));
  } else {
    console.log("no dialog visible");
  }

  // ---------- (b) consumer Gemini app ----------
  console.log("\n=== B: gemini.google.com ===");
  const g = await (await session.context()).newPage();
  const found: number[] = [];
  g.on("response", async (r) => {
    const ct = r.headers()["content-type"] ?? "";
    try {
      if (ct.startsWith("image/")) {
        const b = await r.body();
        if (b.length > 20000) found.push(b.length);
      } else if (ct.includes("json") || ct.includes("text")) {
        for (const b of extractImagesFromText(await r.text())) found.push(b.length);
      }
    } catch { /* body unavailable */ }
  });

  await g.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded" });
  await g.waitForLoadState("networkidle").catch(() => {});
  console.log("url:", g.url());
  console.log("signed in:", !/accounts\.google\.com/.test(g.url()));

  const box = g.locator('div[contenteditable="true"], rich-textarea div[contenteditable], textarea').first();
  const haveBox = await box.isVisible({ timeout: 15000 }).catch(() => false);
  console.log("prompt box visible:", haveBox);

  if (haveBox) {
    await box.click();
    await box.type("Generate an image of a single ripe banana on a plain white background", { delay: 5 });
    await sleep(500);
    const send = g.locator('button[aria-label*="Send" i], button[aria-label*="Submit" i], mat-icon[fonticon="send"]').first();
    if (await send.isVisible({ timeout: 3000 }).catch(() => false)) await send.click().catch(() => {});
    else await g.keyboard.press("Enter");
    console.log("submitted; waiting up to 120s...");

    for (let i = 0; i < 12; i++) {
      await sleep(10000);
      const big = await g.evaluate(() =>
        Array.from(document.querySelectorAll("img")).filter((im) => im.naturalWidth >= 256).length,
      ).catch(() => -1);
      console.log(`  t+${(i + 1) * 10}s bigImgs=${big} netImages=${found.length}`);
      if (big > 0 || found.length > 0) break;
    }
    await g.screenshot({ path: "/tmp/bb-gemini-app.png" }).catch(() => {});
    console.log("network image payloads:", found.map((n) => `${Math.round(n / 1024)}KB`).join(", ") || "(none)");
    const turn = await g.locator("model-response, message-content").last().textContent().catch(() => null);
    console.log("response text:", turn?.replace(/\s+/g, " ").slice(0, 300) ?? "(none)");
    console.log("screenshot: /tmp/bb-gemini-app.png");
  }
} finally {
  await session.close();
}
