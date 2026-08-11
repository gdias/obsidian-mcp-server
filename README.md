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

Le serveur prend désormais en charge OAuth 2.1, requis par les clients Claude qui
déclenchent une connexion OAuth. Après avoir ajouté le serveur, suivez la page de
connexion affichée par Claude. Le client s'enregistre automatiquement, utilise
Authorization Code + PKCE, puis renouvelle ses jetons automatiquement.

> Le serveur doit être servi publiquement en HTTPS. La valeur de
> `MCP_OAUTH_ISSUER` doit correspondre exactement à son URL publique, sans `/`
> final (par exemple `https://mcp.example.fr`).

---

## Variables d'environnement

| Variable | Défaut | Description |
| --- | --- | --- |
| `PORT` | `3000` | Port d'écoute |
| `VAULT_PATH` | `/vault` | Chemin du vault dans le container |
| `MCP_OAUTH_ISSUER` | — | URL HTTPS publique du serveur OAuth ; active OAuth avec les deux variables suivantes |
| `MCP_OAUTH_USERNAME` | — | Identifiant du propriétaire du vault |
| `MCP_OAUTH_PASSWORD` | — | Mot de passe du propriétaire du vault (à générer long et aléatoire) |
| `MCP_OAUTH_ACCESS_TOKEN_TTL` | `3600` | Durée de vie d'un access token, en secondes |
| `MCP_OAUTH_REFRESH_TOKEN_TTL` | `2592000` | Durée de vie d'un refresh token, en secondes |
| `MCP_AUTH_TOKEN` | — | Mode de repli historique par Bearer statique ; obligatoire seulement sans OAuth |

Exemple de `.env` :

```env
MCP_OAUTH_ISSUER=https://mcp.example.fr
MCP_OAUTH_USERNAME=guillaume
MCP_OAUTH_PASSWORD=changez-ceci-par-un-secret-long-et-aleatoire
```

Si Claude ouvre déjà une URL contenant `client_id=gdias`, enregistrez ce client
dans le même `.env` (sinon Claude utilisera l'enregistrement dynamique) :

```env
MCP_OAUTH_CLIENT_ID=gdias
MCP_OAUTH_CLIENT_NAME=Claude
MCP_OAUTH_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback
```

### Endpoints OAuth exposés

| Endpoint | Rôle |
| --- | --- |
| `/.well-known/oauth-protected-resource` | Découverte MCP/RFC 9728 |
| `/.well-known/oauth-authorization-server` | Métadonnées OAuth 2.1 |
| `/register` | Enregistrement dynamique du client (RFC 7591) |
| `/authorize` | Connexion et consentement utilisateur |
| `/token` | Échange et renouvellement des jetons |

Les anciens chemins préfixés par `/oauth` restent acceptés pour compatibilité.

Les clients et jetons sont conservés en mémoire : redémarrer le conteneur invalide
les sessions OAuth existantes et demandera simplement une nouvelle connexion.
