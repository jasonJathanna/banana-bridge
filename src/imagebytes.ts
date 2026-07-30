/**
 * Content sniffing for image payloads.
 *
 * The primary capture strategy reads AI Studio's generate RPC response, whose JSON
 * shape is an internal detail that changes without notice. Rather than parse it, we
 * pull every long base64-ish string out of the body and keep the ones whose decoded
 * bytes start with real image magic. That survives schema churn entirely.
 */

export type ImageFormat = "png" | "jpeg" | "webp" | "gif";

const EXT: Record<ImageFormat, string> = { png: "png", jpeg: "jpg", webp: "webp", gif: "gif" };
const MIME: Record<ImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export function sniffFormat(buf: Buffer): ImageFormat | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buf.toString("ascii", 0, 3) === "GIF") return "gif";
  return null;
}

export function extensionFor(format: ImageFormat): string {
  return EXT[format];
}

export function mimeFor(format: ImageFormat): string {
  return MIME[format];
}

/** PNG/JPEG/WebP/GIF dimensions straight from the header, no image library needed. */
export function readDimensions(buf: Buffer): { width: number; height: number } | null {
  const format = sniffFormat(buf);
  if (!format) return null;

  if (format === "png" && buf.length >= 24) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  if (format === "gif" && buf.length >= 10) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  if (format === "webp") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X" && buf.length >= 30) {
      const w = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16));
      const h = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16));
      return { width: w, height: h };
    }
    if (chunk === "VP8 " && buf.length >= 30) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L" && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }

  // JPEG: walk the marker segments looking for a start-of-frame.
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1]!;
    // SOF0..SOF15, excluding the non-frame markers DHT/JPGA/DAC.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    const segmentLength = buf.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null;
    offset += 2 + segmentLength;
  }
  return null;
}

/** Normalizes base64url and missing padding, then decodes. */
export function decodeBase64(candidate: string): Buffer {
  let s = candidate.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const pad = s.length % 4;
  if (pad === 2) s += "==";
  else if (pad === 3) s += "=";
  else if (pad === 1) s = s.slice(0, -1);
  return Buffer.from(s, "base64");
}

const BASE64_RUN = /[A-Za-z0-9+/_-]{512,}={0,2}/g;

/**
 * Extracts every embedded image from an arbitrary text body, deduped by content.
 * `minBytes` filters out icons and 1x1 spacers that occasionally ride along.
 */
export function extractImagesFromText(body: string, minBytes = 4096): Buffer[] {
  const found: Buffer[] = [];
  const seen = new Set<string>();

  for (const match of body.matchAll(BASE64_RUN)) {
    const raw = match[0];
    const buf = decodeBase64(raw);
    if (buf.length < minBytes) continue;
    if (!sniffFormat(buf)) continue;
    const key = `${buf.length}:${buf.subarray(0, 64).toString("base64")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(buf);
  }
  return found;
}

/** Pulls bytes out of a `data:image/...;base64,...` URL. */
export function decodeDataUrl(url: string): Buffer | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!match) return null;
  const payload = match[3]!;
  const buf = match[2] ? decodeBase64(payload) : Buffer.from(decodeURIComponent(payload), "binary");
  return sniffFormat(buf) ? buf : null;
}
