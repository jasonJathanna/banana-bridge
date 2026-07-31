/**
 * Four failure modes that need four different fixes. Keeping them distinct is the
 * whole point — collapsing them into "generation failed" makes the server
 * undebuggable when the UI shifts under us.
 */
export type FailureKind =
  | "not_logged_in"
  | "quota_exhausted"
  | "safety_blocked"
  | "ui_changed"
  | "invalid_input"
  | "dialog_blocked"
  | "timeout"
  | "browser_unavailable";

export class BananaError extends Error {
  readonly kind: FailureKind;
  readonly hint: string;
  readonly debugPath?: string;

  constructor(kind: FailureKind, message: string, hint: string, debugPath?: string) {
    super(message);
    this.name = "BananaError";
    this.kind = kind;
    this.hint = hint;
    this.debugPath = debugPath;
  }

  static notLoggedIn(debugPath?: string): BananaError {
    return new BananaError(
      "not_logged_in",
      "No signed-in Google session in the browser profile.",
      "Run `npx banana-bridge login` once and sign in by hand, then retry.",
      debugPath,
    );
  }

  static quotaExhausted(used: number, limit: number): BananaError {
    return new BananaError(
      "quota_exhausted",
      `Daily image quota looks exhausted (${used}/${limit} counted locally).`,
      "Wait for the quota to roll over, or raise BANANA_DAILY_LIMIT if the real limit is higher.",
    );
  }

  static safetyBlocked(detail: string): BananaError {
    return new BananaError(
      "safety_blocked",
      `Gemini refused the prompt: ${detail}`,
      "Rephrase the prompt. This is a model-side refusal, not a bug in the bridge.",
    );
  }

  static uiChanged(what: string, debugPath?: string): BananaError {
    return new BananaError(
      "ui_changed",
      `Could not find expected AI Studio UI: ${what}`,
      "The web UI likely changed. Run `npx banana-bridge recon` to re-derive selectors; see the debug dump.",
      debugPath,
    );
  }

  static invalidInput(detail: string): BananaError {
    return new BananaError(
      "invalid_input",
      detail,
      'Crop accepts "none", "auto", "bottom:6%", "48px", or 1/2/4 comma-separated values.',
    );
  }

  static dialogBlocked(dialogText: string, debugPath?: string): BananaError {
    return new BananaError(
      "dialog_blocked",
      `A modal dialog is blocking the AI Studio page and would not dismiss: "${dialogText.slice(0, 300)}"`,
      "Open AI Studio in a normal browser, clear the dialog by hand, then retry. If it is an " +
        "upgrade/billing prompt, this account may not have free image generation on this surface. " +
        "The bridge never clicks anything that could enable billing.",
      debugPath,
    );
  }

  static timeout(ms: number, debugPath?: string): BananaError {
    return new BananaError(
      "timeout",
      `Generation did not finish within ${ms}ms.`,
      "Retry, raise BANANA_TIMEOUT_MS, or check the debug screenshot for a blocking dialog.",
      debugPath,
    );
  }
}

export function describeError(err: unknown): { kind: FailureKind | "unknown"; message: string; hint?: string; debugPath?: string } {
  if (err instanceof BananaError) {
    return { kind: err.kind, message: err.message, hint: err.hint, debugPath: err.debugPath };
  }
  return { kind: "unknown", message: err instanceof Error ? err.message : String(err) };
}
