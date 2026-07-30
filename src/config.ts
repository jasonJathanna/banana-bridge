import os from "node:os";
import path from "node:path";

const home = os.homedir();

function dataHome(): string {
  return process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

const root = path.join(dataHome(), "banana-bridge");

export const config = {
  /** Chrome profile dir holding the Google session. Created by `banana-bridge login`. */
  profileDir: process.env.BANANA_PROFILE_DIR || path.join(root, "profile"),
  /** Where generated images land when no explicit output_path is given. */
  outputDir: process.env.BANANA_OUTPUT_DIR || path.join(root, "images"),
  /** Quota counter + last-reset date. */
  stateFile: process.env.BANANA_STATE_FILE || path.join(root, "state.json"),
  /** Screenshots + HTML dumps written when a generation fails. */
  debugDir: process.env.BANANA_DEBUG_DIR || path.join(root, "debug"),

  /** Headless is opt-in: Google fingerprints headless Chrome. Prefer xvfb-run. */
  headless: envBool("BANANA_HEADLESS", false),
  /** Uses installed Chrome by default; set to "chromium" for a Playwright build. */
  browserChannel: process.env.BANANA_BROWSER_CHANNEL || "chrome",
  executablePath: process.env.BANANA_CHROME_PATH || undefined,

  timeoutMs: envInt("BANANA_TIMEOUT_MS", 180_000),
  navTimeoutMs: envInt("BANANA_NAV_TIMEOUT_MS", 60_000),
  /** Local estimate only — Google is the authority on the real quota. */
  dailyLimit: envInt("BANANA_DAILY_LIMIT", 100),
  model: process.env.BANANA_MODEL || "gemini-2.5-flash-image",
  studioUrl: process.env.BANANA_STUDIO_URL || "https://aistudio.google.com/prompts/new_chat",
  /** Extra pause between jobs so we don't hammer the UI. */
  pacingMs: envInt("BANANA_PACING_MS", 1_500),
  /**
   * Default crop applied to every generated image, e.g. "auto", "bottom:6%",
   * "0,0,48px,0". Defaults to no crop: silently trimming pixels off every image
   * would be a surprising default. See `banana-bridge probe-watermark` to calibrate.
   */
  crop: process.env.BANANA_CROP || "none",
  debug: envBool("BANANA_DEBUG", false),
} as const;

export type Config = typeof config;
