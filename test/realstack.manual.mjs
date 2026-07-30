// Exercises the REAL stack — real Chrome, real AiStudioProvider, no stubs — through a
// real stdio MCP client. Verifies the server degrades cleanly without a Google session
// instead of hanging or crashing. Not part of `npm test`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scratch = process.env.SCRATCH;
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/src/cli.js"],
  env: {
    ...process.env,
    BANANA_HEADLESS: "1",
    BANANA_PROFILE_DIR: `${scratch}/real-profile`,
    BANANA_STATE_FILE: `${scratch}/real-state.json`,
    BANANA_DEBUG_DIR: `${scratch}/real-debug`,
    BANANA_OUTPUT_DIR: `${scratch}/real-images`,
    BANANA_TIMEOUT_MS: "90000",
    BANANA_CROP: "auto",
  },
  stderr: "pipe",
});

const client = new Client({ name: "realstack", version: "0.0.0" });
const t0 = Date.now();
await client.connect(transport);
console.log(`connected in ${Date.now() - t0}ms`);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

function show(label, result) {
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  const images = result.content.filter((c) => c.type === "image").length;
  console.log(`\n--- ${label} (t+${secs}s, isError=${result.isError ?? false}, images=${images}) ---`);
  console.log(text);
}

show("session_status", await client.callTool({ name: "session_status", arguments: {} }));

show(
  "generate_image (no session)",
  await client.callTool({ name: "generate_image", arguments: { prompt: "a rubber duck on a beach" } }),
);

show(
  "generate_image (bad crop)",
  await client.callTool({ name: "generate_image", arguments: { prompt: "x", crop: "sideways:4px" } }),
);

await client.close();
console.log("\nREAL STACK OK");
process.exit(0);
