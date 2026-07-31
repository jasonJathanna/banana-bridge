/**
 * Four failure modes that need four different fixes. Keeping them distinct is the
 * whole point — collapsing them into "generation failed" makes the server
 * undebuggable when the UI shifts under us.
 */
export type FailureKind =
  | "not_logged_in"
  | "quota_exhausted"
  | "busy"
  | "safety_blocked"
  | "ui_changed"
  | "invalid_input"
  | "dialog_blocked"
  | "upload_unsupported"
  | "timeout"
  | "browser_unavailable";

export class BananaError extends Error {
  readonly kind: FailureKind;
  readonly hint: string;
  readonly debugPath?: string;
  /** True only when GOOGLE refused, not when the local estimate ran out. */
  remoteQuota = false;

  constructor(kind: FailureKind, message: string, hint: string, debugPath?: string) {
    // Provider errors can carry huge browser logs; a tool result is not the place.
    super(message.length > 600 ? `${message.slice(0, 600)}…` : message);
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

  /**
   * Google refused because of ITS OWN limit, which is the authority — the local counter
   * is only an estimate and can be well short of the real ceiling.
   */
  static quotaExhaustedRemote(detail: string): BananaError {
    const err = new BananaError(
      "quota_exhausted",
      `Google refused the request because its own usage limit was reached: ${detail.slice(0, 200)}`,
      "This is Google's limit, not the local counter, so it is the real ceiling. Wait for it to " +
        "reset (typically the next day). Further requests are refused locally until then; delete " +
        "the state file to clear that early.",
    );
    err.remoteQuota = true;
    return err;
  }

  static busy(): BananaError {
    return new BananaError(
      "busy",
      "An image is already being generated. Only one generation runs at a time.",
      "Wait for the in-flight request to finish before starting another — do not retry " +
        "immediately. A generation takes roughly 20 seconds, an edit roughly 30.",
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

  static uploadUnsupported(debugPath?: string): BananaError {
    return new BananaError(
      "upload_unsupported",
      "Could not attach the input image: gemini.google.com accepts files only through a " +
        "native OS file picker (File System Access API), which cannot be automated, and it " +
        "ignores synthetic drop and paste events.",
      "Use BANANA_PROVIDER=aistudio for image editing if that account has AI Studio access " +
        "(it exposes a real file input), or edit the image with a local tool. generate_image " +
        "is unaffected.",
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
