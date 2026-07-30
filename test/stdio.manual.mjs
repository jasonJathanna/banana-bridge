import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/src/cli.js"],
  env: { ...process.env, BANANA_HEADLESS: "1" },
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
console.log("instructions present:", Boolean(client.getInstructions()));
for (const t of tools) console.log(` - ${t.name}: required=${JSON.stringify(t.inputSchema.required ?? [])}`);
await client.close();
console.log("STDIO OK");
process.exit(0);
