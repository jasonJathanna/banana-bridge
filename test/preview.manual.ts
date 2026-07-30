// Live check of the canvas-based preview path. Needs a real Chrome; not part of `npm test`.
import assert from "node:assert/strict";
import { BrowserSession } from "../src/browser.js";
import zlib from "node:zlib";
import { readDimensions, sniffFormat } from "../src/imagebytes.js";

// 1200x800 PNG built in-process so the resize has something to shrink.
function bigPng(): Buffer {
  const w = 1200, h = 800;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    for (let x = 0; x < w; x++) {
      raw[row + 1 + x * 3] = x % 256;
      raw[row + 2 + x * 3] = y % 256;
      raw[row + 3 + x * 3] = 128;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, "ascii");
    let c = 0xffffffff;
    for (const b of Buffer.concat([t, data])) {
      c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const session = new BrowserSession({ headless: true });
try {
  const source = bigPng();
  console.log("source:", source.length, "bytes", readDimensions(source));
  const preview = await session.makePreview(source, "image/png");
  assert.ok(preview, "preview should be produced");
  const buf = Buffer.from(preview, "base64");
  const dims = readDimensions(buf);
  console.log("preview:", buf.length, "bytes", sniffFormat(buf), dims);
  assert.equal(sniffFormat(buf), "jpeg");
  assert.deepEqual(dims, { width: 512, height: 341 });
  assert.ok(buf.length < source.length / 4, "preview should be much smaller");
  console.log("PREVIEW OK");
} finally {
  await session.close();
}
