# Obsidian MCP Server

Serveur MCP (Model Context Protocol) pour donner accès à un vault Obsidian depuis Claude.

## Outils disponibles

| Outil                   | Description                      |
| ----------------------- | -------------------------------- |
| `obsidian_list_notes`   | Liste toutes les notes du vault  |
| `obsidian_read_note`    | Lit le contenu d'une note        |
| `obsidian_search`       | Recherche dans titres + contenus |
| `obsidian_list_folders` | Liste les dossiers               |
| `obsidian_write_note`   | Crée/remplace une note           |
| `obsidian_append_note`  | Ajoute du contenu à une note     |
| `obsidian_delete_note`  | Supprime une note                |

### Étape 3 — Connecter à Claude

Dans claude.ai → **Settings** → **Integrations** → **Add MCP Server** :

```
URL: https://mcp.[DOMAINE].fr/mcp
```

---

## Variables d'environnement

| Variable     | Défaut   | Description                       |
| ------------ | -------- | --------------------------------- |
| `PORT`       | `3000`   | Port d'écoute                     |
| `VAULT_PATH` | `/vault` | Chemin du vault dans le container |
