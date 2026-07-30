import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
// Type-only: erased at runtime, so it does not load config before the env is set.
import type { ImageProvider, ImageOps, ServerDeps } from "../src/server.js";
import type { CropRect } from "../src/crop.js";

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "banana-server-test-"));
process.env.BANANA_OUTPUT_DIR = path.join(sandbox, "images");
process.env.BANANA_STATE_FILE = path.join(sandbox, "state.json");
process.env.BANANA_DEBUG_DIR = path.join(sandbox, "debug");
process.env.BANANA_DAILY_LIMIT = "5";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createServer } = await import("../src/server.js");
const { SerialQueue } = await import("../src/queue.js");
const { BananaError } = await import("../src/errors.js");
const { sniffFormat } = await import("../src/imagebytes.js");

/** A real PNG of arbitrary dimensions, so percentage crops resolve to real numbers. */
function widePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, "ascii");
    let c = 0xffffffff;
    for (const b of Buffer.concat([t, data])) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.alloc(height * (1 + width * 3)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A 4x4 PNG standing in for a crop result, distinguishable from the 1x1 source. */
function croppedPng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mNkYPjPgAxGQxoAAM8ADwGvXaEAAAAASUVORK5CYII=",
    "base64",
  );
}

/** 1x1 PNG, distinct byte patterns per call so we can tell images apart. */
function png(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
  );
}

interface Recorded {
  prompt: string;
  count: number;
  aspectRatio?: string;
  imagePaths?: string[];
}

function stubDeps(behavior: {
  images?: number;
  text?: string;
  fail?: Error;
  readyFail?: Error;
  cropFails?: boolean;
  sourceDims?: { width: number; height: number };
}): { deps: ServerDeps; calls: Recorded[]; crops: CropRect[] } {
  const calls: Recorded[] = [];
  const crops: CropRect[] = [];

  const provider: ImageProvider = {
    async generate(request) {
      calls.push({
        prompt: request.prompt,
        count: request.count,
        aspectRatio: request.aspectRatio,
        imagePaths: request.imagePaths,
      });
      if (behavior.fail) throw behavior.fail;
      const source = behavior.sourceDims
        ? widePng(behavior.sourceDims.width, behavior.sourceDims.height)
        : png();
      return {
        images: Array.from({ length: behavior.images ?? 1 }, () => source),
        text: behavior.text ?? "",
      };
    },
    async ensureReady() {
      if (behavior.readyFail) throw behavior.readyFail;
      return true;
    },
  };

  const session: ImageOps = {
    isOpen: true,
    async makePreview() {
      return Buffer.from("fake-preview-jpeg").toString("base64");
    },
    async cropImage(_buf, _mime, rect) {
      crops.push(rect);
      if (behavior.cropFails) return null;
      // A real crop re-encodes; a distinguishable PNG is enough for assertions.
      return croppedPng();
    },
  };

  return { deps: { provider, session, queue: new SerialQueue(0) }, calls, crops };
}

async function connect(deps: ServerDeps) {
  const server = createServer(deps);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

type ToolContent = { type: string; text?: string; data?: string; mimeType?: string };

function contentOf(result: unknown): ToolContent[] {
  return (result as { content: ToolContent[] }).content;
}

async function freshState(): Promise<void> {
  await fs.rm(process.env.BANANA_STATE_FILE!, { force: true });
}

test("tools are advertised with usable schemas", async () => {
  const { deps } = stubDeps({});
  const client = await connect(deps);
  const { tools } = await client.listTools();

  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["edit_image", "generate_image", "session_status"],
  );

  const generate = tools.find((t) => t.name === "generate_image")!;
  assert.deepEqual(generate.inputSchema.required, ["prompt"]);
  assert.deepEqual(
    Object.keys(generate.inputSchema.properties as object).sort(),
    ["aspect_ratio", "count", "crop", "inline", "output_path", "prompt"],
  );

  const edit = tools.find((t) => t.name === "edit_image")!;
  assert.deepEqual(edit.inputSchema.required, ["prompt", "image_paths"]);
});

test("generate_image saves a file and returns a preview", async () => {
  await freshState();
  const { deps, calls } = stubDeps({ images: 1, text: "Here you go." });
  const client = await connect(deps);

  const target = path.join(sandbox, "out", "duck.png");
  const result = await client.callTool({
    name: "generate_image",
    arguments: { prompt: "a rubber duck", aspect_ratio: "16:9", output_path: target },
  });

  assert.notEqual((result as { isError?: boolean }).isError, true);
  const content = contentOf(result);

  const text = content[0]!.text!;
  assert.match(text, /Generated 1 image:/);
  assert.match(text, new RegExp(escapeRegExp(target)));
  assert.match(text, /1x1, png/);
  assert.match(text, /1\/5 used today, 4 left/);
  assert.match(text, /Model said: Here you go\./);

  // The image on disk is the real bytes; the inline content is the small preview.
  assert.equal(sniffFormat(await fs.readFile(target)), "png");
  const image = content.find((c) => c.type === "image")!;
  assert.equal(image.mimeType, "image/jpeg");
  assert.equal(Buffer.from(image.data!, "base64").toString(), "fake-preview-jpeg");

  // Aspect ratio reaches the provider rather than being silently dropped.
  assert.equal(calls[0]!.aspectRatio, "16:9");
  assert.equal(calls[0]!.count, 1);
});

test("inline:true returns full-resolution bytes instead of a preview", async () => {
  await freshState();
  const { deps } = stubDeps({ images: 1 });
  const client = await connect(deps);

  const result = await client.callTool({
    name: "generate_image",
    arguments: { prompt: "inline please", inline: true },
  });

  const image = contentOf(result).find((c) => c.type === "image")!;
  assert.equal(image.mimeType, "image/png");
  assert.deepEqual(Buffer.from(image.data!, "base64"), png());
});

test("multiple images are all saved and counted once each", async () => {
  await freshState();
  const { deps, calls } = stubDeps({ images: 3 });
  const client = await connect(deps);

  const result = await client.callTool({
    name: "generate_image",
    arguments: { prompt: "three cats", count: 3 },
  });

  const text = contentOf(result)[0]!.text!;
  assert.match(text, /Generated 3 images:/);
  assert.match(text, /3\/5 used today, 2 left/);
  assert.equal(calls[0]!.count, 3);

  const files = await fs.readdir(path.join(sandbox, "images"));
  const forThisPrompt = files.filter((f) => f.includes("three-cats"));
  assert.equal(forThisPrompt.length, 3);
});

test("edit_image forwards the input paths", async () => {
  await freshState();
  const { deps, calls } = stubDeps({ images: 1 });
  const client = await connect(deps);

  const input = path.join(sandbox, "input.png");
  await fs.writeFile(input, png());

  const result = await client.callTool({
    name: "edit_image",
    arguments: { prompt: "make it stormy", image_paths: [input] },
  });

  assert.notEqual((result as { isError?: boolean }).isError, true);
  assert.deepEqual(calls[0]!.imagePaths, [input]);
});

test("quota exhaustion is reported as an error, not a generation attempt", async () => {
  await freshState();
  const { deps, calls } = stubDeps({ images: 1 });
  const client = await connect(deps);

  for (let i = 0; i < 5; i++) {
    await client.callTool({ name: "generate_image", arguments: { prompt: `fill ${i}` } });
  }
  assert.equal(calls.length, 5);

  const result = await client.callTool({ name: "generate_image", arguments: { prompt: "one too many" } });
  assert.equal((result as { isError?: boolean }).isError, true);
  const text = contentOf(result)[0]!.text!;
  assert.match(text, /\[quota_exhausted\]/);
  assert.match(text, /5\/5 counted locally/);
  // The provider was never called, so no request was wasted.
  assert.equal(calls.length, 5);
});

test("each failure kind keeps its own label and hint", async () => {
  for (const [error, expected] of [
    [BananaError.notLoggedIn("/tmp/dump"), /\[not_logged_in\].*\n.*banana-bridge login/s],
    [BananaError.safetyBlocked("policy violation"), /\[safety_blocked\].*policy violation/s],
    [BananaError.uiChanged("prompt box"), /\[ui_changed\].*recon/s],
    [BananaError.timeout(1234), /\[timeout\].*1234ms/s],
  ] as const) {
    await freshState();
    const { deps } = stubDeps({ fail: error });
    const client = await connect(deps);
    const result = await client.callTool({ name: "generate_image", arguments: { prompt: "x" } });
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(contentOf(result)[0]!.text!, expected);
  }
});

test("an unexpected error still returns a structured tool error", async () => {
  await freshState();
  const { deps } = stubDeps({ fail: new Error("chrome crashed") });
  const client = await connect(deps);
  const result = await client.callTool({ name: "generate_image", arguments: { prompt: "x" } });
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(contentOf(result)[0]!.text!, /\[unknown\] chrome crashed/);
});

test("session_status reports signed-in state and quota", async () => {
  await freshState();
  const { deps } = stubDeps({ images: 1 });
  const client = await connect(deps);

  const ok = contentOf(await client.callTool({ name: "session_status", arguments: {} }))[0]!.text!;
  assert.match(ok, /Signed in: yes/);
  assert.match(ok, /0\/5 used/);

  const { deps: badDeps } = stubDeps({ readyFail: BananaError.notLoggedIn() });
  const badClient = await connect(badDeps);
  const bad = contentOf(await badClient.callTool({ name: "session_status", arguments: {} }))[0]!.text!;
  assert.match(bad, /Signed in: no \(not_logged_in/);
  assert.match(bad, /banana-bridge login/);
});

test("invalid arguments are rejected before reaching the provider", async () => {
  await freshState();
  const { deps, calls } = stubDeps({ images: 1 });
  const client = await connect(deps);

  const result = await client.callTool({ name: "generate_image", arguments: { prompt: "too many", count: 9 } });
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.equal(calls.length, 0);
});

test("a crop that rounds to zero pixels is a silent no-op", async () => {
  await freshState();
  const { deps, crops } = stubDeps({ images: 1 });
  const client = await connect(deps);

  const target = path.join(sandbox, "cropped", "duck.png");
  const result = await client.callTool({
    name: "generate_image",
    arguments: { prompt: "duck", output_path: target, crop: "bottom:25%" },
  });

  // 1x1 source: 25% of 1px rounds to 0, so the browser is never involved.
  assert.notEqual((result as { isError?: boolean }).isError, true);
  assert.deepEqual(crops, []);
  assert.doesNotMatch(contentOf(result)[0]!.text!, /Crop/);
  assert.deepEqual(await fs.readFile(target), png());
});

test("a crop larger than the image is an error, not a 0-pixel file", async () => {
  await freshState();
  const { deps, crops } = stubDeps({ images: 1 });
  const client = await connect(deps);

  const result = await client.callTool({
    name: "generate_image",
    arguments: { prompt: "duck", crop: "bottom:2px" },
  });

  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(contentOf(result)[0]!.text!, /\[invalid_input\].*entire image/s);
  assert.equal(crops.length, 0, "a 2px crop of a 1px image is rejected, not attempted");
});

test("a viable crop reaches the browser and the cropped bytes are what get saved", async () => {
  await freshState();
  const { deps, crops } = stubDeps({ images: 1, sourceDims: { width: 400, height: 200 } });
  const client = await connect(deps);

  const target = path.join(sandbox, "cropwork", "out.png");
  const result = await client.callTool({
    name: "generate_image",
    arguments: { prompt: "wide thing", output_path: target, crop: "bottom:10%" },
  });

  assert.notEqual((result as { isError?: boolean }).isError, true);
  assert.deepEqual(crops, [{ x: 0, y: 0, width: 400, height: 180 }]);

  const text = contentOf(result)[0]!.text!;
  assert.match(text, /Crop: cropped 400x200 -> 400x180/);
  // The file on disk is the cropped image, not the original.
  assert.deepEqual(await fs.readFile(target), croppedPng());
  assert.match(text, /4x4, png/);
});

test("a failed crop keeps the original image and says so", async () => {
  await freshState();
  const { deps } = stubDeps({ images: 1, sourceDims: { width: 400, height: 200 }, cropFails: true });
  const client = await connect(deps);

  const target = path.join(sandbox, "cropfail", "out.png");
  const result = await client.callTool({
    name: "generate_image",
    arguments: { prompt: "keep me", output_path: target, crop: "bottom:10%" },
  });

  assert.notEqual((result as { isError?: boolean }).isError, true);
  assert.match(contentOf(result)[0]!.text!, /Crop failed in the browser; saved the uncropped image/);
  assert.deepEqual(await fs.readFile(target), widePng(400, 200));
});

test("an unparseable crop is rejected before any quota is spent", async () => {
  await freshState();
  const { deps, calls } = stubDeps({ images: 1 });
  const client = await connect(deps);

  const result = await client.callTool({
    name: "generate_image",
    arguments: { prompt: "x", crop: "sideways:4px" },
  });

  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(contentOf(result)[0]!.text!, /\[invalid_input\] Unknown crop side/);
  assert.equal(calls.length, 0, "provider must not be called");
});

test("crop applies to every image in a multi-image result", async () => {
  await freshState();
  const { deps, crops } = stubDeps({ images: 3, sourceDims: { width: 400, height: 200 } });
  const client = await connect(deps);

  await client.callTool({
    name: "generate_image",
    arguments: { prompt: "trio", count: 3, crop: "bottom:10%" },
  });

  assert.equal(crops.length, 3);
  for (const rect of crops) assert.deepEqual(rect, { x: 0, y: 0, width: 400, height: 180 });
});

test("edit_image accepts crop too", async () => {
  await freshState();
  const { deps, crops } = stubDeps({ images: 1, sourceDims: { width: 400, height: 200 } });
  const client = await connect(deps);

  const input = path.join(sandbox, "edit-input.png");
  await fs.writeFile(input, png());
  await client.callTool({
    name: "edit_image",
    arguments: { prompt: "tweak", image_paths: [input], crop: "auto" },
  });

  assert.deepEqual(crops, [{ x: 0, y: 0, width: 400, height: 188 }]);
});

test("provenance is disclosed in the server instructions and every tool description", async () => {
  const { deps } = stubDeps({});
  const client = await connect(deps);

  assert.match(client.getInstructions()!, /AI-generated/);
  assert.match(client.getInstructions()!, /SynthID/);

  const { tools } = await client.listTools();
  for (const name of ["generate_image", "edit_image"]) {
    const tool = tools.find((t) => t.name === name)!;
    assert.match(tool.description!, /AI-generated/, `${name} description`);
    assert.match(tool.description!, /SynthID/, `${name} description`);
  }
});

test("every successful result carries the provenance note", async () => {
  await freshState();
  const { deps } = stubDeps({ images: 1, sourceDims: { width: 400, height: 200 } });
  const client = await connect(deps);

  const plain = await client.callTool({ name: "generate_image", arguments: { prompt: "a" } });
  assert.match(contentOf(plain)[0]!.text!, /Provenance: AI-generated by Gemini; contains an invisible SynthID/);

  // Still present after a crop — cropping removes a visible mark, not SynthID.
  const cropped = await client.callTool({
    name: "generate_image",
    arguments: { prompt: "b", crop: "bottom:10%" },
  });
  const text = contentOf(cropped)[0]!.text!;
  assert.match(text, /Crop: cropped 400x200 -> 400x180/);
  assert.match(text, /invisible SynthID/);

  const input = path.join(sandbox, "prov-input.png");
  await fs.writeFile(input, png());
  const edited = await client.callTool({
    name: "edit_image",
    arguments: { prompt: "c", image_paths: [input] },
  });
  assert.match(contentOf(edited)[0]!.text!, /invisible SynthID/);
});

test("session_status reports the browser as running once the check has started it", async () => {
  await freshState();
  // Mirrors the real session: the browser is lazily started by ensureReady().
  let started = false;
  const deps: ServerDeps = {
    provider: {
      async generate() {
        throw new Error("not used");
      },
      async ensureReady() {
        started = true;
        return true;
      },
    },
    session: {
      get isOpen() {
        return started;
      },
      async makePreview() {
        return null;
      },
      async cropImage() {
        return null;
      },
    },
    queue: new SerialQueue(0),
  };

  const text = contentOf(await connect(deps).then((c) => c.callTool({ name: "session_status", arguments: {} })))[0]!
    .text!;
  assert.match(text, /Signed in: yes/);
  assert.match(text, /Browser: running/, "must reflect state after the readiness check, not before");
});

test("session_status puts the hint last, after the status block", async () => {
  await freshState();
  const { deps } = stubDeps({ readyFail: BananaError.notLoggedIn() });
  const client = await connect(deps);
  const text = contentOf(await client.callTool({ name: "session_status", arguments: {} }))[0]!.text!;

  const lines = text.split("\n");
  assert.match(lines[0]!, /Signed in: no/);
  assert.match(lines.at(-1)!, /Hint:/);
  assert.ok(
    lines.findIndex((l) => l.startsWith("Queue depth")) < lines.length - 1,
    "quota/queue lines come before the hint",
  );
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test.after(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});
