"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const express_1 = __importDefault(require("express"));
const read_js_1 = require("./tools/read.js");
const write_js_1 = require("./tools/write.js");
const vault_js_1 = require("./services/vault.js");
const server = new mcp_js_1.McpServer({
    name: "obsidian-mcp-server",
    version: "1.0.0",
});
(0, read_js_1.registerReadTools)(server);
(0, write_js_1.registerWriteTools)(server);
async function main() {
    const app = (0, express_1.default)();
    app.use(express_1.default.json({ limit: "10mb" }));
    // Health check
    app.get("/health", (_req, res) => {
        res.json({ status: "ok", vault: vault_js_1.VAULT_PATH, timestamp: new Date().toISOString() });
    });
    // MCP endpoint
    app.post("/mcp", async (req, res) => {
        const transport = new streamableHttp_js_1.StreamableHTTPServerTransport({
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
        console.error(`📁 Vault: ${vault_js_1.VAULT_PATH}`);
        console.error(`🔗 Endpoint MCP: http://localhost:${port}/mcp`);
    });
}
main().catch((err) => {
    console.error("Erreur fatale:", err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map