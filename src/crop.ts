/**
 * Crop-spec parsing and rect resolution.
 *
 * Kept free of any browser dependency so the arithmetic — the part that is easy to
 * get subtly wrong — is unit-testable on its own.
 */

export type Unit = "px" | "pct";

export interface Inset {
  value: number;
  unit: Unit;
}

export interface CropSpec {
  top: Inset;
  right: Inset;
  bottom: Inset;
  left: Inset;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const ZERO: Inset = { value: 0, unit: "px" };

/**
 * The Gemini app stamps its sparkle mark in the bottom-RIGHT corner, inset from both
 * edges. Measured on a real 1024x559 result: a 10% right inset clears it and keeps the
 * full subject, while clearing it from the bottom would cost ~19% of the height. Hence
 * a right inset rather than a bottom band. Calibrate with `banana-bridge probe-watermark`.
 */
export const AUTO_SPEC: CropSpec = {
  top: ZERO,
  right: { value: 10, unit: "pct" },
  bottom: ZERO,
  left: ZERO,
};

const SIDES = ["top", "right", "bottom", "left"] as const;
type Side = (typeof SIDES)[number];

function parseInset(raw: string): Inset | null {
  const match = /^(\d+(?:\.\d+)?)\s*(px|%)?$/i.exec(raw.trim());
  if (!match) return null;
  const value = Number.parseFloat(match[1]!);
  if (!Number.isFinite(value) || value < 0) return null;
  return { value, unit: match[2] === "%" ? "pct" : "px" };
}

/**
 * Accepts:
 *   "none"                  -> null (no crop)
 *   "auto"                  -> AUTO_SPEC
 *   "bottom:6%"             -> named sides, comma separated
 *   "12"  "12px"  "3%"      -> all four sides
 *   "10,20"                 -> vertical, horizontal
 *   "0,0,6%,0"              -> top, right, bottom, left
 * Throws on anything else rather than silently cropping the wrong region.
 */
export function parseCropSpec(input: string | undefined | null): CropSpec | null {
  if (input === undefined || input === null) return null;
  const value = input.trim().toLowerCase();
  if (value === "" || value === "none" || value === "off" || value === "false") return null;
  if (value === "auto") return AUTO_SPEC;

  const tokens = value.split(",").map((t) => t.trim()).filter((t) => t !== "");
  if (tokens.length === 0) return null;

  if (tokens.some((t) => t.includes(":"))) {
    const spec: CropSpec = { top: ZERO, right: ZERO, bottom: ZERO, left: ZERO };
    for (const token of tokens) {
      const [name, rest, ...extra] = token.split(":");
      if (rest === undefined || extra.length > 0) throw new Error(`Invalid crop token: "${token}"`);
      const side = name!.trim() as Side;
      if (!SIDES.includes(side)) throw new Error(`Unknown crop side: "${name}"`);
      const inset = parseInset(rest);
      if (!inset) throw new Error(`Invalid crop amount: "${rest}"`);
      spec[side] = inset;
    }
    return spec;
  }

  const insets = tokens.map((token) => {
    const inset = parseInset(token);
    if (!inset) throw new Error(`Invalid crop amount: "${token}"`);
    return inset;
  });

  switch (insets.length) {
    case 1:
      return { top: insets[0]!, right: insets[0]!, bottom: insets[0]!, left: insets[0]! };
    case 2:
      return { top: insets[0]!, right: insets[1]!, bottom: insets[0]!, left: insets[1]! };
    case 4:
      return { top: insets[0]!, right: insets[1]!, bottom: insets[2]!, left: insets[3]! };
    default:
      throw new Error(`Crop needs 1, 2 or 4 values (got ${insets.length})`);
  }
}

function toPixels(inset: Inset, extent: number): number {
  return Math.round(inset.unit === "pct" ? (extent * inset.value) / 100 : inset.value);
}

/**
 * Resolves a spec against real dimensions. Returns null when the crop is a no-op, and
 * throws when it would consume the whole image — better a clear error than a 0x0 file.
 */
export function resolveCropRect(spec: CropSpec, width: number, height: number): CropRect | null {
  const top = toPixels(spec.top, height);
  const bottom = toPixels(spec.bottom, height);
  const left = toPixels(spec.left, width);
  const right = toPixels(spec.right, width);

  if (top === 0 && bottom === 0 && left === 0 && right === 0) return null;

  const cropWidth = width - left - right;
  const cropHeight = height - top - bottom;
  if (cropWidth <= 0 || cropHeight <= 0) {
    throw new Error(
      `Crop removes the entire image (${width}x${height} minus ` +
        `${left}/${right} horizontal, ${top}/${bottom} vertical)`,
    );
  }

  return { x: left, y: top, width: cropWidth, height: cropHeight };
}

export function describeCrop(rect: CropRect, from: { width: number; height: number }): string {
  return `cropped ${from.width}x${from.height} -> ${rect.width}x${rect.height} (offset ${rect.x},${rect.y})`;
}
