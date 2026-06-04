"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerWriteTools = registerWriteTools;
const zod_1 = require("zod");
const vault_js_1 = require("../services/vault.js");
function registerWriteTools(server) {
    server.registerTool("obsidian_write_note", {
        title: "Write Note",
        description: `Crée ou remplace une note Obsidian.
⚠️ Écrase le contenu existant si la note existe déjà.

Args:
  - path (string): Chemin relatif dans le vault (ex: "Projets/mon-projet.md")
  - content (string): Contenu Markdown complet de la note

Returns: Métadonnées de la note créée/modifiée.`,
        inputSchema: zod_1.z.object({
            path: zod_1.z.string().min(1).describe("Chemin relatif (ex: 'Projets/mon-projet.md')"),
            content: zod_1.z.string().describe("Contenu Markdown complet"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, async ({ path, content }) => {
        const note = await (0, vault_js_1.writeNote)(path, content);
        return {
            content: [{ type: "text", text: `✅ Note sauvegardée: ${note.path}\n📁 ${note.folder} | ${note.size} octets` }],
            structuredContent: note,
        };
    });
    server.registerTool("obsidian_append_note", {
        title: "Append to Note",
        description: `Ajoute du contenu à la fin d'une note Obsidian existante.
Si la note n'existe pas, elle est créée.

Args:
  - path (string): Chemin relatif dans le vault
  - content (string): Contenu Markdown à ajouter

Returns: Métadonnées de la note mise à jour.`,
        inputSchema: zod_1.z.object({
            path: zod_1.z.string().min(1).describe("Chemin relatif de la note"),
            content: zod_1.z.string().min(1).describe("Contenu Markdown à ajouter à la fin"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async ({ path, content }) => {
        const note = await (0, vault_js_1.appendToNote)(path, content);
        return {
            content: [{ type: "text", text: `✅ Contenu ajouté à: ${note.path}\n📁 ${note.folder} | ${note.size} octets` }],
            structuredContent: note,
        };
    });
    server.registerTool("obsidian_delete_note", {
        title: "Delete Note",
        description: `Supprime définitivement une note du vault Obsidian.
⚠️ Action irréversible.

Args:
  - path (string): Chemin relatif dans le vault

Returns: Confirmation de suppression.`,
        inputSchema: zod_1.z.object({
            path: zod_1.z.string().min(1).describe("Chemin relatif de la note à supprimer"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, async ({ path }) => {
        await (0, vault_js_1.deleteNote)(path);
        return {
            content: [{ type: "text", text: `🗑️ Note supprimée: ${path}` }],
            structuredContent: { deleted: true, path },
        };
    });
}
//# sourceMappingURL=write.js.map