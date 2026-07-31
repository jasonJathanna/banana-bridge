import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

interface QuotaState {
  /** Local calendar date (YYYY-MM-DD) the counter belongs to. */
  day: string;
  used: number;
  lastGeneratedAt?: string;
}

function today(): string {
  const now = new Date();
  const m = `${now.getMonth() + 1}`.padStart(2, "0");
  const d = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${m}-${d}`;
}

/** Set when the state file existed but could not be parsed — surfaced by quotaStatus. */
let lastReadCorrupt = false;

async function read(): Promise<QuotaState> {
  let raw: string;
  try {
    raw = await fs.readFile(config.stateFile, "utf8");
  } catch {
    // Missing state is the normal first-run case, not corruption.
    lastReadCorrupt = false;
    return { day: today(), used: 0 };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<QuotaState>;
    lastReadCorrupt = false;
    // A different day is a rollover, not corruption.
    if (parsed.day === today() && typeof parsed.used === "number" && Number.isFinite(parsed.used)) {
      return { day: parsed.day, used: Math.max(0, parsed.used), lastGeneratedAt: parsed.lastGeneratedAt };
    }
    if (typeof parsed.day !== "string" || typeof parsed.used !== "number") lastReadCorrupt = true;
  } catch {
    // Unparseable: the counter is lost, which silently REMOVES the quota guard for the
    // rest of the day. Start at zero to stay usable, but make it visible.
    lastReadCorrupt = true;
  }
  return { day: today(), used: 0 };
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
    corrupt: lastReadCorrupt,
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
