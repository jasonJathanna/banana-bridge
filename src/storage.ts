import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { extensionFor, readDimensions, sniffFormat, type ImageFormat } from "./imagebytes.js";

export interface SavedImage {
  path: string;
  bytes: number;
  format: ImageFormat;
  width?: number;
  height?: number;
}

function slug(prompt: string): string {
  return (
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "image"
  );
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
}

/**
 * Writes one image to disk. `outputPath` is honored when given; when generating
 * several images for one prompt, an index suffix is appended so nothing is clobbered.
 */
export async function saveImage(
  buf: Buffer,
  prompt: string,
  options: { outputPath?: string; index?: number; total?: number } = {},
): Promise<SavedImage> {
  const format = sniffFormat(buf);
  if (!format) throw new Error("Captured bytes are not a recognizable image");

  let target: string;
  if (options.outputPath) {
    const resolved = path.resolve(options.outputPath);
    if ((options.total ?? 1) > 1 && options.index !== undefined) {
      const ext = path.extname(resolved);
      const base = ext ? resolved.slice(0, -ext.length) : resolved;
      target = `${base}-${options.index + 1}${ext || `.${extensionFor(format)}`}`;
    } else {
      target = path.extname(resolved) ? resolved : `${resolved}.${extensionFor(format)}`;
    }
  } else {
    const suffix = (options.total ?? 1) > 1 ? `-${(options.index ?? 0) + 1}` : "";
    target = path.join(config.outputDir, `${stamp()}-${slug(prompt)}${suffix}.${extensionFor(format)}`);
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buf);

  const dims = readDimensions(buf);
  return { path: target, bytes: buf.length, format, width: dims?.width, height: dims?.height };
}

export async function writeDebugDump(
  label: string,
  parts: { screenshot?: Buffer; html?: string; notes?: string },
): Promise<string> {
  const dir = path.join(config.debugDir, `${stamp()}-${label}`);
  await fs.mkdir(dir, { recursive: true });
  if (parts.screenshot) await fs.writeFile(path.join(dir, "screenshot.png"), parts.screenshot);
  if (parts.html) await fs.writeFile(path.join(dir, "page.html"), parts.html, "utf8");
  if (parts.notes) await fs.writeFile(path.join(dir, "notes.txt"), parts.notes, "utf8");
  return dir;
}
