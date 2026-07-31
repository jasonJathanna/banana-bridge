// Drives the REGISTERED server the way an agent would: discover tools from the listing,
// then call them using only the advertised schema. Consumes real quota.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";

const CMD = JSON.parse(fs.readFileSync(`${process.env.HOME}/.claude.json`, "utf8"))
  .mcpServers["banana-bridge"];
console.log("launching exactly what Claude Code launches:", CMD.command, CMD.args.join(" "), "\n");

const client = new Client({ name: "pretend-agent", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: CMD.command, args: CMD.args, stderr: "pipe" }));

console.log("=== what the agent sees ===");
console.log("instructions:", (client.getInstructions() ?? "").slice(0, 200), "...\n");
const { tools } = await client.listTools();
for (const t of tools) {
  const props = Object.keys(t.inputSchema.properties ?? {});
  console.log(`- ${t.name}(${props.join(", ")})  required=[${(t.inputSchema.required ?? []).join(",")}]`);
  console.log(`    ${(t.description ?? "").slice(0, 130)}...`);
}

const call = async (name, args, label) => {
  const t = Date.now();
  let r;
  try {
    r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  } catch (e) {
    console.log(`\n### ${label} -> THREW after ${((Date.now() - t) / 1000).toFixed(1)}s: ${e.message}`);
    return null;
  }
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  const text = r.content.find((c) => c.type === "text")?.text ?? "";
  const imgs = r.content.filter((c) => c.type === "image");
  console.log(`\n### ${label} -> ${r.isError ? "ERROR" : "ok"} in ${secs}s, ${imgs.length} preview(s)`);
  console.log(text.split("\n").map((l) => "    " + l).join("\n"));
  return { r, text };
};

await call("session_status", {}, "session_status");

// An agent would pass just a prompt.
const gen = await call("generate_image", { prompt: "a small potted cactus on a windowsill" }, "generate_image (minimal args)");
const genPath = gen?.text.match(/^\s*1\. (\S+\.(?:png|jpg))/m)?.[1];
console.log("\n  parsed path:", genPath ?? "COULD NOT PARSE PATH FROM OUTPUT");

// Now the untested tool, chaining on the previous output the way an agent would.
if (genPath && fs.existsSync(genPath)) {
  await call("edit_image", { prompt: "make the background a deep blue", image_paths: [genPath] }, "edit_image (chained on previous output)");
} else {
  console.log("\n### edit_image SKIPPED — no usable path from generate_image");
}

// Same call again, this time taking the crop advice the previous result gave.
await call("generate_image", { prompt: "a small potted cactus on a windowsill", crop: "auto" }, "generate_image (crop: auto)");

// Narrow aspect ratio: the auto crop's pixel floor should still clear the mark.
await call("generate_image", { prompt: "a lighthouse at dusk", aspect_ratio: "9:16", crop: "auto" }, "generate_image (9:16 + crop auto)");

// Fire two at once: the second must be refused immediately, not queued.
console.log("\n### concurrency check: two generate_image calls at once ###");
const t = Date.now();
const [a, b] = await Promise.all([
  client.callTool({ name: "generate_image", arguments: { prompt: "a tin robot on a desk" } }, undefined, { timeout: 300_000 }),
  (async () => {
    await new Promise((r) => setTimeout(r, 300));
    const busy = await client.callTool({ name: "generate_image", arguments: { prompt: "should be refused" } }, undefined, { timeout: 60_000 });
    console.log(`    second call returned after ${((Date.now() - t) / 1000).toFixed(1)}s: ${busy.isError ? "ERROR" : "ok"}`);
    console.log("   ", (busy.content.find((c) => c.type === "text")?.text ?? "").split("\n").join("\n    "));
    // And session_status while busy:
    const st = await client.callTool({ name: "session_status", arguments: {} }, undefined, { timeout: 60_000 });
    console.log("    session_status while busy:", (st.content[0]?.text ?? "").split("\n")[0]);
    return busy;
  })(),
]);
console.log(`    first call: ${a.isError ? "ERROR" : "ok"} after ${((Date.now() - t) / 1000).toFixed(1)}s`);
void b;

await client.close();
console.log("\ndone");
process.exit(0);
