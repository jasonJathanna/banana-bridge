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

test("state writes are atomic and leave no temp files behind", async () => {
  await fs.rm(process.env.BANANA_STATE_FILE!, { force: true });
  await recordUsage(2);

  const dir = path.dirname(process.env.BANANA_STATE_FILE!);
  const leftovers = (await fs.readdir(dir)).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, [], "temp file must be renamed, not left in place");

  // The file on disk is complete, parseable JSON — a truncated write would read back as
  // "0 used", silently removing the quota guard for the rest of the day.
  const raw = await fs.readFile(process.env.BANANA_STATE_FILE!, "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.used, 2);
  assert.equal((await quotaStatus()).corrupt, false);
});

test("a corrupt state file is reported, not silently treated as a fresh day", async () => {
  await fs.writeFile(process.env.BANANA_STATE_FILE!, "{ truncated", "utf8");
  const status = await quotaStatus();
  assert.equal(status.used, 0, "stays usable");
  assert.equal(status.corrupt, true, "but the lost count is visible");

  // A missing file is the normal first run and must NOT be flagged.
  await fs.rm(process.env.BANANA_STATE_FILE!, { force: true });
  assert.equal((await quotaStatus()).corrupt, false);
});

test("the corruption notice survives the next write, not just the first read", async () => {
  await fs.writeFile(process.env.BANANA_STATE_FILE!, "{ truncated", "utf8");
  assert.equal((await quotaStatus()).corrupt, true);

  // A module-level flag would be cleared by this write, dropping the notice at exactly
  // the point where the counter is known to be wrong.
  await recordUsage(1);
  const after = await quotaStatus();
  assert.equal(after.used, 1);
  assert.equal(after.corrupt, true, "still latched after a successful write");

  await recordUsage(1);
  assert.equal((await quotaStatus()).corrupt, true, "and after another");

  // It must clear on a day rollover, though.
  const raw = JSON.parse(await fs.readFile(process.env.BANANA_STATE_FILE!, "utf8"));
  assert.equal(raw.resetFromCorruption, true, "latched in the file, not in memory");
  await fs.writeFile(
    process.env.BANANA_STATE_FILE!,
    JSON.stringify({ ...raw, day: "2001-01-01" }),
    "utf8",
  );
  assert.equal((await quotaStatus()).corrupt, false, "a new day starts clean");
});

test("a rollover to a new day is not mistaken for corruption", async () => {
  await fs.writeFile(process.env.BANANA_STATE_FILE!, JSON.stringify({ day: "2001-01-01", used: 42 }), "utf8");
  const status = await quotaStatus();
  assert.equal(status.used, 0);
  assert.equal(status.corrupt, false, "old but valid state is a rollover");
});

test("a negative or non-finite counter cannot grant extra quota", async () => {
  await fs.writeFile(process.env.BANANA_STATE_FILE!, JSON.stringify({ day: todayStamp(), used: -100 }), "utf8");
  assert.equal((await quotaStatus()).used, 0, "clamped, so -100 does not buy 100 extra images");

  // JSON has no NaN/Infinity literal, but 1e999 parses to Infinity — which would make
  // remaining negative and every hasQuota() check pass.
  await fs.writeFile(process.env.BANANA_STATE_FILE!, '{"day":"' + todayStamp() + '","used":1e999}', "utf8");
  const status = await quotaStatus();
  assert.equal(Number.isFinite(status.used), true);
  assert.equal(status.used, 0);
  assert.equal(status.corrupt, true, "a non-finite counter is corruption, not a valid state");
});

test("an output_path that is a directory writes INTO it, like cp", async () => {
  const dir = path.join(sandbox, "iam-a-directory");
  await fs.mkdir(dir, { recursive: true });

  const saved = await saveImage(PNG, "a red pixel", { outputPath: dir });

  // Previously extname("") was empty, so ".png" was appended and the image landed in a
  // SIBLING file named after the directory — silently, which is the worst kind.
  assert.equal(path.dirname(saved.path), dir, "file goes inside the directory");
  assert.match(path.basename(saved.path), /a-red-pixel\.png$/);
  assert.equal((await fs.readdir(dir)).length, 1);
  assert.equal(await fs.stat(`${dir}.png`).then(() => true, () => false), false, "no sibling file");
});

test("multiple images into a directory output_path do not collide", async () => {
  const dir = path.join(sandbox, "multi-dir");
  await fs.mkdir(dir, { recursive: true });
  const a = await saveImage(PNG, "twins", { outputPath: dir, index: 0, total: 2 });
  const b = await saveImage(PNG, "twins", { outputPath: dir, index: 1, total: 2 });
  assert.notEqual(a.path, b.path);
  assert.equal((await fs.readdir(dir)).length, 2);
});

function todayStamp(): string {
  const n = new Date();
  return `${n.getFullYear()}-${`${n.getMonth() + 1}`.padStart(2, "0")}-${`${n.getDate()}`.padStart(2, "0")}`;
}

test.after(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});
