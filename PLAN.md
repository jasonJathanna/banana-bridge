# banana-bridge — plan

An MCP server that generates images with Gemini's "Nano Banana" model by driving
**aistudio.google.com** in a real browser, so generations bill against the free
web-session quota instead of a paid API key.

## Ground truth / constraints

- Automating the AI Studio web UI is outside Google's Terms of Service. The realistic
  risk is rate-limiting or action against the Google account used — not a legal one.
  Use a throwaway/secondary Google account, keep concurrency at 1, and add human-ish
  pacing. Decision noted; proceeding as asked.
- The web UI is not a stable contract. Selectors will break. The mitigation that
  actually holds up is **reading the network response, not the DOM** (see Phase 2).
- Free image quota is per-day and per-account. We track it locally but treat the
  server's counter as an estimate, not authority.

## Architecture

```
MCP client (Claude Code / Desktop)
        │  stdio, JSON-RPC
        ▼
  src/server.ts          MCP server: tool schemas, validation, error mapping
        │
        ▼
  src/queue.ts           serial job queue (concurrency 1, timeouts, retries)
        │
        ▼
  src/browser.ts         Playwright persistent context (own profile dir)
        │
        ▼
  src/providers/aistudio.ts   navigate · set model · submit prompt · capture image
        │
        ▼
  src/storage.ts         write PNG/JPEG to output dir, return path (+ small preview)
```

Single long-lived browser process for the server's lifetime, lazily started on the
first tool call, torn down on SIGTERM/stdin close.

## Phases

### Phase 0 — scaffold
- TypeScript, Node 22, ESM. `tsx` for dev, `tsc` for build.
- Deps: `@modelcontextprotocol/sdk`, `playwright`, `zod`.
- Config via env with defaults: `BANANA_PROFILE_DIR` (default
  `~/.local/share/banana-bridge/profile`), `BANANA_OUTPUT_DIR` (default
  `~/.local/share/banana-bridge/images`), `BANANA_HEADLESS`, `BANANA_TIMEOUT_MS`,
  `BANANA_DAILY_LIMIT` (default 100).

### Phase 1 — login flow (separate from the server)
An MCP tool call can't run an interactive Google login, so login is its own command:

```
npx banana-bridge login
```

Launches a **headed** Chrome (`channel: 'chrome'`, `launchPersistentContext` on the
profile dir), navigates to AI Studio, waits for the user to sign in manually, then
confirms the session and exits. Cookies persist in the profile dir; the server
reuses it. `npx banana-bridge doctor` re-checks the session and prints quota state.

Headless is opt-in, not default — Google fingerprints headless Chrome aggressively.
On Linux, `xvfb-run` is the reliable "invisible but not headless" answer.

### Phase 2 — capture the image reliably
Ordered by robustness, implement top-down with fallback:

1. **Network interception (primary).** Attach `page.on('response')` before submitting
   and match the AI Studio generate RPC. The response carries the image as
   base64/inline data; decode straight to bytes. No DOM scraping, no download dialog,
   full resolution.
2. **DOM + download (fallback).** Locate the newest result image, click its
   download/save action, catch the Playwright `download` event.
3. **Screenshot of the image element (last resort).** Lossy; only to avoid a hard
   failure.

The exact RPC path and payload shape have to be read off a live session — that's the
first real implementation task, done with a scratch Playwright script that logs all
responses for one manual generation. Everything else depends on it.

### Phase 3 — MCP tools

| Tool | Input | Output |
|---|---|---|
| `generate_image` | `prompt`, optional `aspect_ratio`, `count` (1–4), `output_path` | saved file path(s), dimensions, quota remaining |
| `edit_image` | `prompt`, `image_paths[]` (uploaded into the chat) | same |
| `session_status` | — | logged-in bool, estimated quota used/remaining, browser state |

Return the **file path** as primary output plus a downscaled base64 preview
(`{type:"image"}`) so the calling model can see the result without a multi-megabyte
blob in context. Full-size base64 only if `inline: true`.

### Phase 4 — reliability
- Serial queue; a second call waits rather than racing the same tab.
- Fresh chat per request (avoids context bleed between prompts) with a configurable
  "reuse conversation" mode for iterative editing.
- Per-request timeout → screenshot + HTML dump to a debug dir on failure, so a broken
  selector is diagnosable instead of just "timed out".
- Distinguish and surface: not-logged-in, quota-exhausted, safety-blocked prompt,
  and UI-changed. These are four different fixes and must not collapse into one error.
- Daily counter in a JSON state file, reset on local-midnight rollover.

### Phase 5 — packaging
- `bin` entry so `npx banana-bridge` works; README with the `claude mcp add` command
  and the login step called out as prerequisite #1.
- Smoke test: `doctor` + one real generation, asserted on file bytes being a valid PNG.

## Open items to resolve during Phase 2
- Whether AI Studio's model picker needs explicit selection per chat or persists in
  the profile.
- Whether multi-image (`count > 1`) is one request or N — affects quota accounting.
- Watermarking: AI Studio outputs carry SynthID. Not removable; document it.
