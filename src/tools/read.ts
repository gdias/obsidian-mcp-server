import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listNotes, readNote, searchNotes, listFolders } from "../services/vault.js";

export function registerReadTools(server: McpServer): void {

  server.registerTool(
    "obsidian_list_notes",
    {
      title: "List Notes",
      description: `Liste toutes les notes Markdown du vault Obsidian.
Retourne chemin, nom, dossier, taille et date de modification triés du plus récent.

Args:
  - folder (string, optionnel): Sous-dossier à explorer (ex: "Projets/SEO")
  - limit (number): Nombre max de notes à retourner (défaut: 50)

Returns: Liste de notes avec path, name, folder, size, modified.`,
      inputSchema: z.object({
        folder: z.string().optional().describe("Sous-dossier (ex: 'Projets/SEO'). Vide = tout le vault"),
        limit: z.number().int().min(1).max(500).default(50).describe("Nombre max de résultats"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ folder, limit }) => {
      const notes = await listNotes(folder);
      const sliced = notes.slice(0, limit);
      const text = sliced.map(n =>
        `📄 ${n.path}\n   Dossier: ${n.folder} | Modifié: ${n.modified.toLocaleDateString("fr-FR")}`
      ).join("\n");
      return {
        content: [{ type: "text", text: `${sliced.length} notes trouvées (total: ${notes.length})\n\n${text}` }],
        structuredContent: { total: notes.length, count: sliced.length, notes: sliced },
      };
    }
  );

  server.registerTool(
    "obsidian_read_note",
    {
      title: "Read Note",
      description: `Lit le contenu complet d'une note Obsidian.

Args:
  - path (string): Chemin relatif dans le vault (ex: "Projets/kokobelli.md")

Returns: Contenu Markdown complet de la note + métadonnées.`,
      inputSchema: z.object({
        path: z.string().min(1).describe("Chemin relatif de la note (ex: 'Projets/kokobelli.md')"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ path }) => {
      const note = await readNote(path);
      return {
        content: [{ type: "text", text: `# ${note.name}\n📁 ${note.folder} | 🕒 ${note.modified.toLocaleDateString("fr-FR")}\n\n---\n\n${note.content}` }],
        structuredContent: note,
      };
    }
  );

  server.registerTool(
    "obsidian_search",
    {
      title: "Search Notes",
      description: `Recherche dans les titres et contenus des notes Obsidian.

Args:
  - query (string): Terme à rechercher
  - folder (string, optionnel): Restreindre la recherche à un dossier
  - max_results (number): Nombre max de résultats (défaut: 20)

Returns: Notes correspondantes avec extrait du contexte trouvé.`,
      inputSchema: z.object({
        query: z.string().min(1).max(200).describe("Terme à rechercher dans les notes"),
        folder: z.string().optional().describe("Restreindre à un sous-dossier"),
        max_results: z.number().int().min(1).max(50).default(20).describe("Nombre max de résultats"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, folder, max_results }) => {
      const results = await searchNotes(query, folder, max_results);
      if (!results.length) {
        return { content: [{ type: "text", text: `Aucune note trouvée pour "${query}"` }] };
      }
      const text = results.map(r =>
        `📄 ${r.path}\n   ${r.excerpt}`
      ).join("\n\n");
      return {
        content: [{ type: "text", text: `${results.length} résultat(s) pour "${query}"\n\n${text}` }],
        structuredContent: { query, count: results.length, results },
      };
    }
  );

  server.registerTool(
    "obsidian_list_folders",
    {
      title: "List Folders",
      description: `Liste les dossiers du vault Obsidian.

Args:
  - parent (string, optionnel): Dossier parent à explorer

Returns: Liste des sous-dossiers.`,
      inputSchema: z.object({
        parent: z.string().optional().describe("Dossier parent (vide = racine du vault)"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ parent }) => {
      const folders = await listFolders(parent);
      const text = folders.length
        ? folders.map(f => `📁 ${f}`).join("\n")
        : "Aucun sous-dossier trouvé";
      return {
        content: [{ type: "text", text }],
        structuredContent: { count: folders.length, folders },
      };
    }
  );
}
