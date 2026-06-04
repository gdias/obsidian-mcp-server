# Obsidian MCP Server

Serveur MCP (Model Context Protocol) pour donner accès à ton vault Obsidian depuis Claude.

## Outils disponibles

| Outil | Description |
|-------|-------------|
| `obsidian_list_notes` | Liste toutes les notes du vault |
| `obsidian_read_note` | Lit le contenu d'une note |
| `obsidian_search` | Recherche dans titres + contenus |
| `obsidian_list_folders` | Liste les dossiers |
| `obsidian_write_note` | Crée/remplace une note |
| `obsidian_append_note` | Ajoute du contenu à une note |
| `obsidian_delete_note` | Supprime une note |

---

## Déploiement sur Coolify

### Étape 1 — Synchroniser ton vault

Choisir une méthode pour que les fichiers Obsidian soient disponibles sur le serveur :

**Option A — Syncthing (recommandé)**
```bash
# Sur le serveur, installer Syncthing et pointer vers /home/user/obsidian-vault
# Sur ton Mac/PC, installer Syncthing et connecter les deux
```

**Option B — Git + cron**
```bash
# Dans ton vault Obsidian, initialiser un repo Git
# Pousser vers un repo privé (GitHub/Gitea)
# Sur le serveur : cron toutes les 5 minutes pour git pull
```

**Option C — rclone avec un cloud (Dropbox, S3...)**
```bash
rclone sync dropbox:Obsidian /home/user/obsidian-vault
```

---

### Étape 2 — Déployer sur Coolify

1. Dans Coolify → **New Project** → **Docker Compose**
2. Coller le contenu de `docker-compose.yml`
3. Modifier la ligne domaine :
   ```yaml
   - "traefik.http.routers.obsidian-mcp.rule=Host(`mcp.TON-DOMAINE.fr`)"
   ```
4. Modifier le volume pour pointer vers ton vault synchronisé :
   ```yaml
   volumes:
     obsidian-vault:
       driver: local
       driver_opts:
         type: none
         o: bind
         device: /home/user/obsidian-vault  # ← ton chemin réel
   ```
5. Cliquer **Deploy**

---

### Étape 3 — Connecter à Claude

Dans claude.ai → **Settings** → **Integrations** → **Add MCP Server** :

```
URL: https://mcp.TON-DOMAINE.fr/mcp
```

---

## Variables d'environnement

| Variable | Défaut | Description |
|----------|--------|-------------|
| `PORT` | `3000` | Port d'écoute |
| `VAULT_PATH` | `/vault` | Chemin du vault dans le container |

---

## Test local

```bash
npm install
npm run build
VAULT_PATH=/chemin/vers/ton/vault npm start
# → http://localhost:3000/health
# → http://localhost:3000/mcp (endpoint MCP)
```
