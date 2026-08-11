import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { VAULT_PATH } from "./services/vault.js";
import { isOAuthEnabled, missingOAuthVariables, oauthConfigurationError, registerOAuthRoutes, requireOAuthToken } from "./oauth.js";

const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const CORS_HEADERS = "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID";

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

  // Browser-based clients need the preflight to pass and must be able to read the
  // WWW-Authenticate challenge, which is otherwise hidden by CORS and leaves the
  // OAuth discovery step with nothing to follow. Origin is reflected rather than
  // allowlisted because authentication is by Bearer token, never by cookie.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
    }
    res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.set("Access-Control-Allow-Headers", CORS_HEADERS);
    res.set("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id");
    res.set("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  registerOAuthRoutes(app);

  // Health check : volontairement laissé public (ne révèle pas le contenu du vault).
  // `build` et `auth` sont là pour répondre sans accès au serveur aux deux questions
  // qui bloquent un débogage de déploiement : quelle version tourne, et dans quel
  // mode d'authentification.
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      build: process.env.BUILD_REF || "unknown",
      auth: isOAuthEnabled() ? "oauth" : "static-token",
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

  // Registered after the POST route so it only catches the other verbs. Answering 405
  // instead of Express' default 404 tells a client the endpoint exists but is
  // POST-only, rather than looking like a wrong URL.
  app.all("/mcp", requireAuth, (_req, res) => {
    res.set("Allow", "POST, OPTIONS").status(405).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Method not allowed: this server exposes MCP over POST /mcp only" },
    });
  });

  const port = parseInt(process.env.PORT || "3000");
  app.listen(port, () => {
    console.error(`✅ MCP Server démarré sur port ${port}`);
    console.error(`📁 Vault: ${VAULT_PATH}`);
    if (isOAuthEnabled()) {
      console.error("🔐 Authentication: OAuth 2.1");
      console.error(`🌐 Issuer: ${process.env.MCP_OAUTH_ISSUER}`);
    } else {
      console.error("🔐 Authentication: static Bearer token");
      // Falling back silently is what makes a half-configured deployment look like a
      // broken client: OAuth clients get a 401 with no discovery hint at all.
      console.error(`⚠️  OAuth inactif — variables manquantes : ${missingOAuthVariables().join(", ")}`);
    }
  });
}

main().catch((err) => {
  console.error("Erreur fatale:", err);
  process.exit(1);
});
