import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { VAULT_PATH } from "./services/vault.js";
import { isOAuthEnabled, oauthConfigurationError, registerOAuthRoutes, requireOAuthToken } from "./oauth.js";

const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isOAuthEnabled()) {
    if (requireOAuthToken(req, res)) next();
    return;
  }

  if (!AUTH_TOKEN) {
    res.status(500).json({
      error:
        "Server error : MCP_AUTH_TOKEN is not set in environment variables",
    });
    return;
  }

  const header = req.headers.authorization ?? "";
  const expected = `Bearer ${AUTH_TOKEN}`;

  if (!safeCompare(header, expected)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

async function main(): Promise<void> {
  const configError = oauthConfigurationError();
  if (configError) {
    console.error(configError);
    process.exit(1);
  }
  if (!isOAuthEnabled() && !AUTH_TOKEN) {
    console.error("MCP_AUTH_TOKEN is required when OAuth is not configured");
    process.exit(1);
  }

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: false }));

  registerOAuthRoutes(app);

  // Health check : volontairement laissé public (ne révèle pas le contenu du vault).
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  });

  app.post("/mcp", requireAuth, async (req, res) => {
    const server = new McpServer({
      name: "obsidian-mcp-server",
      version: "1.0.0",
    });

    registerReadTools(server);
    registerWriteTools(server);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = parseInt(process.env.PORT || "3000");
  app.listen(port, () => {
    console.error(`✅ MCP Server démarré sur port ${port}`);
    console.error(`📁 Vault: ${VAULT_PATH}`);
    console.error(isOAuthEnabled() ? "🔐 Authentication: OAuth 2.1" : "🔐 Authentication: static Bearer token");
  });
}

main().catch((err) => {
  console.error("Erreur fatale:", err);
  process.exit(1);
});
