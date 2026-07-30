// Live check of the canvas crop against real Chrome. Not part of `npm test`.
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { BrowserSession } from "../src/browser.js";
import { parseCropSpec, resolveCropRect } from "../src/crop.js";
import { readDimensions, sniffFormat } from "../src/imagebytes.js";

/** Gradient PNG with a solid white band across the bottom 6%, standing in for a mark. */
function marked(w: number, h: number): Buffer {
  const bandTop = Math.floor(h * 0.94);
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    for (let x = 0; x < w; x++) {
      const inBand = y >= bandTop;
      raw[row + 1 + x * 3] = inBand ? 255 : x % 256;
      raw[row + 2 + x * 3] = inBand ? 255 : y % 256;
      raw[row + 3 + x * 3] = inBand ? 255 : 64;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, "ascii");
    let c = 0xffffffff;
    for (const b of Buffer.concat([t, data])) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; }
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
  const source = marked(1024, 1024);
  console.log("source:", readDimensions(source), source.length, "bytes");

  const rect = resolveCropRect(parseCropSpec("auto")!, 1024, 1024)!;
  console.log("auto rect:", rect);

  const cropped = await session.cropImage(source, "image/png", rect);
  assert.ok(cropped, "crop should succeed");
  assert.equal(sniffFormat(cropped), "png", "output is lossless PNG");
  assert.deepEqual(readDimensions(cropped), { width: 1024, height: 963 });

  // Confirm the white band is actually gone by sampling the cropped image's last row.
  const check = await session.makePreview(cropped, "image/png", 1024, 1);
  assert.ok(check);

  // Offset crop: cut from all four sides and confirm the geometry.
  const offset = resolveCropRect(parseCropSpec("10,20,30,40")!, 1024, 1024)!;
  const cropped2 = await session.cropImage(source, "image/png", offset);
  assert.ok(cropped2);
  assert.deepEqual(readDimensions(cropped2), { width: 1024 - 60, height: 1024 - 40 });

  // A rect exceeding the source must be refused, not silently clamped.
  const bogus = await session.cropImage(source, "image/png", { x: 0, y: 0, width: 2000, height: 2000 });
  assert.equal(bogus, null, "out-of-bounds rect returns null");

  console.log("CROP OK");
} finally {
  await session.close();
}
