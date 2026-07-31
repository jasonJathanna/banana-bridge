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

/**
 * True when a headed browser has somewhere to draw.
 *
 * Only Linux/BSD advertise a display through DISPLAY/WAYLAND_DISPLAY. macOS and Windows
 * never set them yet run headed Chrome perfectly well, so sniffing those variables there
 * would silently force headless — the mode Google fingerprints — on every such user.
 */
function hasDisplay(): boolean {
  if (process.platform === "darwin" || process.platform === "win32") return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

const PROVIDERS = ["gemini-app", "aistudio"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

/**
 * A typo like BANANA_PROVIDER=ai-studio must not silently run the other surface while
 * diagnostics echo the bogus name back. Fall back, but record the bad value so
 * session_status and doctor can say what happened.
 */
function providerFromEnv(): { provider: ProviderName; invalid?: string } {
  const raw = (process.env.BANANA_PROVIDER || "").trim();
  if (raw === "") return { provider: "gemini-app" };
  if ((PROVIDERS as readonly string[]).includes(raw)) return { provider: raw as ProviderName };
  return { provider: "gemini-app", invalid: raw };
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

  /**
   * Headed by default — Google fingerprints headless Chrome — but only where a display
   * exists. An MCP server is often spawned without one on Linux, where a headed launch
   * cannot start at all, so fall back to headless rather than failing. BANANA_HEADLESS
   * overrides either way. See hasDisplay() for the platform caveat.
   */
  headless: envBool("BANANA_HEADLESS", !hasDisplay()),
  /** Recorded so diagnostics can explain which way the fallback went. */
  hasDisplay: hasDisplay(),
  /** Uses installed Chrome by default; set to "chromium" for a Playwright build. */
  browserChannel: process.env.BANANA_BROWSER_CHANNEL || "chrome",
  executablePath: process.env.BANANA_CHROME_PATH || undefined,

  timeoutMs: envInt("BANANA_TIMEOUT_MS", 180_000),
  navTimeoutMs: envInt("BANANA_NAV_TIMEOUT_MS", 60_000),
  /** Local estimate only — Google is the authority on the real quota. */
  dailyLimit: envInt("BANANA_DAILY_LIMIT", 100),
  /**
   * Which web surface to drive. "gemini-app" (gemini.google.com) is the default because
   * AI Studio gates Run behind a billing dialog on free accounts; "aistudio" is kept
   * for accounts that do have AI Studio access.
   */
  provider: providerFromEnv().provider,
  /** Set when BANANA_PROVIDER held an unrecognized value that was ignored. */
  providerInvalid: providerFromEnv().invalid,
  model: process.env.BANANA_MODEL || "gemini-2.5-flash-image",
  geminiAppUrl: process.env.BANANA_GEMINI_URL || "https://gemini.google.com/app",
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
