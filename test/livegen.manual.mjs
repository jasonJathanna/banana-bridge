// One real generation against a logged-in AI Studio session, through a real MCP client.
// Consumes real free-tier quota. Not part of `npm test`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/src/cli.js"],
  env: { ...process.env, BANANA_TIMEOUT_MS: "240000" },
  stderr: "pipe",
});
const client = new Client({ name: "livegen", version: "0.0.0" });
const t0 = Date.now();
await client.connect(transport);

// MCP clients default to a 60s request timeout; a browser-driven generation needs more.
const result = await client.callTool(
  {
    name: "generate_image",
    arguments: { prompt: process.argv[2] ?? "a single ripe banana on a plain white background, studio photo" },
  },
  undefined,
  { timeout: 300_000 },
);

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n--- generate_image (t+${secs}s, isError=${result.isError ?? false}) ---`);
for (const c of result.content) {
  if (c.type === "text") console.log(c.text);
  else console.log(`[${c.type}] ${c.mimeType}, ${Math.round((c.data?.length ?? 0) * 0.75 / 1024)} KB decoded`);
}
await client.close();
process.exit(result.isError ? 1 : 0);
