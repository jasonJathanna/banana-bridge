import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

interface QuotaState {
  /** Local calendar date (YYYY-MM-DD) the counter belongs to. */
  day: string;
  used: number;
  lastGeneratedAt?: string;
  /**
   * Latched for the rest of the day once an unreadable state file forced a reset to
   * zero. This has to live IN the file: a module-level flag is recomputed on every read,
   * so the first successful write would clear it — losing the disclosure at exactly the
   * point where the counter is known to be wrong.
   */
  resetFromCorruption?: boolean;
}

function today(): string {
  const now = new Date();
  const m = `${now.getMonth() + 1}`.padStart(2, "0");
  const d = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${m}-${d}`;
}

/** Read-only: never writes, so callers can read freely. */
async function read(): Promise<QuotaState> {
  let raw: string;
  try {
    raw = await fs.readFile(config.stateFile, "utf8");
  } catch {
    // Missing state is the normal first-run case, not corruption.
    return { day: today(), used: 0 };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<QuotaState>;

    // Shape first, day second. Checking the day first would let a malformed counter for
    // TODAY fall through to the rollover branch and read as a clean new day — JSON has no
    // NaN/Infinity literal, but 1e999 parses to Infinity and is still `typeof "number"`.
    const shapeOk =
      typeof parsed.day === "string" && typeof parsed.used === "number" && Number.isFinite(parsed.used);
    if (!shapeOk) return { day: today(), used: 0, resetFromCorruption: true };

    // Well-formed but for another day: an ordinary rollover, and the latch does not carry.
    if (parsed.day !== today()) return { day: today(), used: 0 };

    return {
      day: parsed.day!,
      used: Math.max(0, parsed.used!),
      lastGeneratedAt: parsed.lastGeneratedAt,
      // Carry the latch forward for the rest of the day.
      resetFromCorruption: parsed.resetFromCorruption === true,
    };
  } catch {
    // Unparseable: the counter is lost, which silently REMOVES the quota guard for the
    // rest of the day. Start at zero to stay usable, but latch it so it stays visible.
    return { day: today(), used: 0, resetFromCorruption: true };
  }
}

/**
 * Atomic write: same-directory temp file plus rename, which is atomic on POSIX. A plain
 * writeFile truncates first, so an interrupted write leaves a partial file — and a
 * partial file reads back as "0 used today", quietly disabling the quota guard.
 */
async function write(state: QuotaState): Promise<void> {
  const dir = path.dirname(config.stateFile);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.state.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await fs.rename(tmp, config.stateFile);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function quotaStatus(): Promise<{
  used: number;
  limit: number;
  remaining: number;
  day: string;
  corrupt: boolean;
}> {
  const state = await read();
  return {
    used: state.used,
    limit: config.dailyLimit,
    remaining: Math.max(0, config.dailyLimit - state.used),
    day: state.day,
    corrupt: state.resetFromCorruption === true,
  };
}

export async function hasQuota(count: number): Promise<boolean> {
  const { used } = await read();
  return used + count <= config.dailyLimit;
}

export async function recordUsage(count: number): Promise<void> {
  const state = await read();
  state.used += count;
  state.lastGeneratedAt = new Date().toISOString();
  await write(state);
}
