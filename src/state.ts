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

async function read(): Promise<QuotaState> {
  try {
    const raw = await fs.readFile(config.stateFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<QuotaState>;
    if (parsed.day === today() && typeof parsed.used === "number") {
      return { day: parsed.day, used: parsed.used, lastGeneratedAt: parsed.lastGeneratedAt };
    }
  } catch {
    // Missing or corrupt state is not an error — start the day at zero.
  }
  return { day: today(), used: 0 };
}

async function write(state: QuotaState): Promise<void> {
  await fs.mkdir(path.dirname(config.stateFile), { recursive: true });
  await fs.writeFile(config.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function quotaStatus(): Promise<{ used: number; limit: number; remaining: number; day: string }> {
  const state = await read();
  return {
    used: state.used,
    limit: config.dailyLimit,
    remaining: Math.max(0, config.dailyLimit - state.used),
    day: state.day,
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
