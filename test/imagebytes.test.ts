import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import {
  decodeBase64,
  decodeDataUrl,
  extractImagesFromText,
  extensionFor,
  mimeFor,
  readDimensions,
  sniffFormat,
} from "../src/imagebytes.js";

/** Builds a minimal but structurally valid PNG of the given dimensions. */
function makePng(width: number, height: number, padBytes = 0): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // truecolor
  const ihdr = chunk("IHDR", ihdrData);

  const raw = Buffer.alloc(height * (1 + width * 3));
  const idat = chunk("IDAT", zlib.deflateSync(raw));
  const extra = padBytes > 0 ? chunk("tEXt", Buffer.alloc(padBytes, 0x61)) : Buffer.alloc(0);
  const iend = chunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, extra, idat, iend]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** JPEG with a real SOF0 segment so the dimension walker has something to find. */
function makeJpeg(width: number, height: number): Buffer {
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2); // segment length
  sof[4] = 8; // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3; // components
  // APP0: length field covers itself plus the 10 bytes of payload that follow.
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x0c]),
    Buffer.from("JFIF\0", "ascii"),
    Buffer.alloc(5),
    sof,
    Buffer.from([0xff, 0xd9]),
  ]);
}

function makeWebpVp8x(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(22, 4);
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8X", 12, "ascii");
  buf.writeUInt32LE(10, 16);
  const w = width - 1;
  const h = height - 1;
  buf[24] = w & 0xff;
  buf[25] = (w >> 8) & 0xff;
  buf[26] = (w >> 16) & 0xff;
  buf[27] = h & 0xff;
  buf[28] = (h >> 8) & 0xff;
  buf[29] = (h >> 16) & 0xff;
  return buf;
}

test("sniffFormat recognizes the formats we can receive", () => {
  assert.equal(sniffFormat(makePng(4, 4)), "png");
  assert.equal(sniffFormat(makeJpeg(8, 8)), "jpeg");
  assert.equal(sniffFormat(makeWebpVp8x(8, 8)), "webp");
  assert.equal(sniffFormat(Buffer.from("GIF89a__________", "ascii")), "gif");
  assert.equal(sniffFormat(Buffer.from("<svg xmlns=...>", "ascii")), null);
  assert.equal(sniffFormat(Buffer.alloc(4)), null);
});

test("readDimensions parses headers without an image library", () => {
  assert.deepEqual(readDimensions(makePng(1024, 768)), { width: 1024, height: 768 });
  assert.deepEqual(readDimensions(makeJpeg(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(readDimensions(makeWebpVp8x(300, 200)), { width: 300, height: 200 });
  assert.equal(readDimensions(Buffer.alloc(4)), null);
});

test("extension and mime mappings agree", () => {
  assert.equal(extensionFor("jpeg"), "jpg");
  assert.equal(mimeFor("png"), "image/png");
});

test("decodeBase64 handles base64url and missing padding", () => {
  const bytes = Buffer.from([0xfb, 0xff, 0xbf, 0x00]);
  const standard = bytes.toString("base64");
  const urlSafe = standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.deepEqual(decodeBase64(urlSafe), bytes);
  assert.deepEqual(decodeBase64(standard), bytes);
});

test("extractImagesFromText finds images regardless of JSON shape", () => {
  const png = makePng(256, 256, 8192);
  const jpeg = Buffer.concat([makeJpeg(300, 300), Buffer.alloc(8192, 0x5a)]);

  // Deliberately unlike any real schema: the extractor must not care.
  const body = JSON.stringify([
    [null, "some prose", { weird: { nesting: [png.toString("base64")] } }],
    ["candidate", { inline: jpeg.toString("base64").replace(/\+/g, "-").replace(/\//g, "_") }],
    ["noise", "c2hvcnQgc3RyaW5n"],
  ]);

  const found = extractImagesFromText(body);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map(sniffFormat).sort(), ["jpeg", "png"]);
  assert.deepEqual(found.find((b) => sniffFormat(b) === "png"), png);
});

test("extractImagesFromText skips payloads below the size floor", () => {
  const tiny = makePng(2, 2);
  const body = JSON.stringify({ icon: tiny.toString("base64").padEnd(600, "A") });
  assert.deepEqual(extractImagesFromText(body), []);
});

test("extractImagesFromText dedupes identical payloads", () => {
  const png = makePng(200, 200, 8192);
  const encoded = png.toString("base64");
  const body = JSON.stringify([encoded, encoded]);
  assert.equal(extractImagesFromText(body).length, 1);
});

test("decodeDataUrl round-trips and rejects non-images", () => {
  const png = makePng(16, 16);
  const url = `data:image/png;base64,${png.toString("base64")}`;
  assert.deepEqual(decodeDataUrl(url), png);
  assert.equal(decodeDataUrl("data:text/plain;base64,aGVsbG8="), null);
  assert.equal(decodeDataUrl("https://example.com/a.png"), null);
});

test("lossy WebP dimensions are rejected without the keyframe start code", () => {
  const good = makeWebpVp8Lossy(320, 240, true);
  assert.deepEqual(readDimensions(good), { width: 320, height: 240 });

  // Same bytes, start code corrupted: previously this returned confident garbage, and
  // dimensions decide which captures get kept.
  const bad = makeWebpVp8Lossy(320, 240, false);
  assert.equal(sniffFormat(bad), "webp", "still sniffs as webp");
  assert.equal(readDimensions(bad), null, "but dimensions must not be trusted");
});

test("percent-encoded data URLs decode to exact bytes", () => {
  // The old decodeURIComponent path did not merely mangle these bytes, it THREW
  // "URIError: URI malformed" (percent-encoded binary is not valid UTF-8) — uncaught,
  // so it propagated out of harvestDom and aborted the whole generation.
  const png = makePng(8, 8);
  const encoded = Array.from(png)
    .map((b) => `%${b.toString(16).padStart(2, "0")}`)
    .join("");
  const decoded = decodeDataUrl(`data:image/png,${encoded}`);
  assert.deepEqual(decoded, png, "round-trips byte for byte");

  const high = png.filter((b) => b > 0x7f).length;
  assert.ok(high > 0, "fixture must actually contain high bytes to be a real test");
});

test("cheap noise runs never hide a later image", () => {
  // The old candidate cap counted 600-char non-image runs, so enough leading noise made a
  // real image invisible and the caller saw a misleading "no image came back".
  const png = makePng(200, 200, 8192);
  const filler = "A".repeat(600);
  const body = [...Array(500).fill(filler), png.toString("base64")].join('","');
  const found = extractImagesFromText(body);
  assert.equal(found.length, 1, "the image is still found behind 500 noise runs");
  assert.deepEqual(found[0], png);
});

test("work is bounded by decoded bytes, not candidate count", () => {
  const png = makePng(200, 200, 8192);
  const body = JSON.stringify([png.toString("base64")]);

  // A budget below the payload stops before decoding it.
  assert.deepEqual(extractImagesFromText(body, 4096, 1024), [], "budget exhausted, nothing decoded");
  // A generous budget finds it.
  assert.equal(extractImagesFromText(body, 4096, 64 * 1024 * 1024).length, 1);
});

test("runs too short to reach minBytes are skipped without decoding", () => {
  // 600 chars decodes to ~450 bytes, well under the 4096 floor, so it must be prefiltered.
  const body = JSON.stringify({ noise: "A".repeat(600) });
  assert.deepEqual(extractImagesFromText(body), []);
});

/** Lossy WebP: VP8 chunk, optionally with a valid 9d 01 2a keyframe start code. */
function makeWebpVp8Lossy(width: number, height: number, validStartCode: boolean): Buffer {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(22, 4);
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8 ", 12, "ascii");
  buf.writeUInt32LE(10, 16);
  buf[20] = 0x00;
  buf[21] = 0x00;
  buf[22] = 0x00;
  buf[23] = validStartCode ? 0x9d : 0x00;
  buf[24] = validStartCode ? 0x01 : 0x00;
  buf[25] = validStartCode ? 0x2a : 0x00;
  buf.writeUInt16LE(width, 26);
  buf.writeUInt16LE(height, 28);
  return buf;
}

test("a payload with unreadable dimensions is dropped by the collector", async () => {
  const { makeCollector } = await import("../src/providers/shared.js");

  // Lossy WebP with a corrupted keyframe start code: sniffs as webp, dimensions unknown.
  // readDimensions returning null used to mean "unknown, keep", so tightening the
  // dimension parser actually LOOSENED this filter and let malformed bytes through.
  const bad = makeWebpVp8Lossy(4, 4, false);
  assert.equal(sniffFormat(bad), "webp");
  assert.equal(readDimensions(bad), null);

  const { images, collect } = makeCollector();
  collect(bad);
  assert.equal(images.length, 0, "suspect payload must not be collectable as a result");

  // A well-formed one of adequate size still gets through.
  const good = makeWebpVp8Lossy(640, 480, true);
  collect(good);
  assert.deepEqual(images, [good]);
});
