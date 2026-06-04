import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { VAULT_PATH } from "./services/vault.js";

const server = new McpServer({
  name: "obsidian-mcp-server",
  version: "1.0.0",
});

registerReadTools(server);
registerWriteTools(server);

async function main(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", vault: VAULT_PATH, timestamp: new Date().toISOString() });
  });

  // MCP endpoint
  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = parseInt(process.env.PORT || "3000");
  app.listen(port, () => {
    console.error(`✅ Obsidian MCP Server démarré sur port ${port}`);
    console.error(`📁 Vault: ${VAULT_PATH}`);
    console.error(`🔗 Endpoint MCP: http://localhost:${port}/mcp`);
  });
}

main().catch((err) => {
  console.error("Erreur fatale:", err);
  process.exit(1);
});
