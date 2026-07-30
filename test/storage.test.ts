import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * config is read at import time, so the temp dirs have to be in the environment
 * before any module under test is loaded.
 */
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "banana-test-"));
process.env.BANANA_OUTPUT_DIR = path.join(sandbox, "images");
process.env.BANANA_STATE_FILE = path.join(sandbox, "state.json");
process.env.BANANA_DEBUG_DIR = path.join(sandbox, "debug");
process.env.BANANA_DAILY_LIMIT = "3";

const { saveImage, writeDebugDump } = await import("../src/storage.js");
const { quotaStatus, hasQuota, recordUsage } = await import("../src/state.js");

/** 1x1 red PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

test("saveImage writes to the output dir with a slugged name", async () => {
  const saved = await saveImage(PNG, "A Very Red Pixel!!");
  assert.equal(path.dirname(saved.path), path.join(sandbox, "images"));
  assert.match(path.basename(saved.path), /a-very-red-pixel\.png$/);
  assert.equal(saved.format, "png");
  assert.equal(saved.bytes, PNG.length);
  assert.deepEqual({ w: saved.width, h: saved.height }, { w: 1, h: 1 });
  assert.deepEqual(await fs.readFile(saved.path), PNG);
});

test("saveImage honors an explicit output path and adds a missing extension", async () => {
  const target = path.join(sandbox, "out", "portrait");
  const saved = await saveImage(PNG, "anything", { outputPath: target });
  assert.equal(saved.path, `${target}.png`);
  assert.deepEqual(await fs.readFile(saved.path), PNG);
});

test("saveImage indexes multiple images so they never clobber each other", async () => {
  const target = path.join(sandbox, "multi", "cat.png");
  const first = await saveImage(PNG, "cat", { outputPath: target, index: 0, total: 2 });
  const second = await saveImage(PNG, "cat", { outputPath: target, index: 1, total: 2 });
  assert.equal(first.path, path.join(sandbox, "multi", "cat-1.png"));
  assert.equal(second.path, path.join(sandbox, "multi", "cat-2.png"));
});

test("saveImage rejects bytes that are not an image", async () => {
  await assert.rejects(saveImage(Buffer.from("not an image at all"), "x"), /not a recognizable image/);
});

test("writeDebugDump collects screenshot, html and notes", async () => {
  const dir = await writeDebugDump("ui-changed", {
    screenshot: PNG,
    html: "<html></html>",
    notes: "url: https://example.com",
  });
  const entries = (await fs.readdir(dir)).sort();
  assert.deepEqual(entries, ["notes.txt", "page.html", "screenshot.png"]);
});

test("quota counts up and blocks past the daily limit", async () => {
  let status = await quotaStatus();
  assert.deepEqual({ used: status.used, limit: status.limit, remaining: status.remaining }, { used: 0, limit: 3, remaining: 3 });

  assert.equal(await hasQuota(3), true);
  assert.equal(await hasQuota(4), false);

  await recordUsage(2);
  status = await quotaStatus();
  assert.equal(status.used, 2);
  assert.equal(status.remaining, 1);
  assert.equal(await hasQuota(1), true);
  assert.equal(await hasQuota(2), false);

  await recordUsage(1);
  assert.equal((await quotaStatus()).remaining, 0);
  assert.equal(await hasQuota(1), false);
});

test("a counter from a previous day resets instead of blocking", async () => {
  await fs.writeFile(process.env.BANANA_STATE_FILE!, JSON.stringify({ day: "2000-01-01", used: 99 }), "utf8");
  const status = await quotaStatus();
  assert.equal(status.used, 0);
  assert.equal(status.remaining, 3);
});

test("corrupt state is treated as a fresh day", async () => {
  await fs.writeFile(process.env.BANANA_STATE_FILE!, "{ not json", "utf8");
  assert.equal((await quotaStatus()).used, 0);
});

test.after(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});
