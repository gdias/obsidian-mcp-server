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
| `MCP_OAUTH_STATE_PATH` | `/data/oauth-state.json` | Fichier où sont conservés les clients enregistrés et les refresh tokens |
| `MCP_AUTH_TOKEN` | — | Mode de repli historique par Bearer statique ; obligatoire seulement sans OAuth |

> Les trois variables `MCP_OAUTH_*` obligatoires doivent être présentes **dans le
> conteneur**. Si elles manquent, le serveur ne refuse pas de démarrer : il retombe
> sur le Bearer statique et n'expose aucun endpoint OAuth, ce qui se traduit côté
> Claude par un échec de connexion sans explication. Le log de démarrage indique
> toujours le mode retenu — voir [Dépannage](#dépannage).

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
| `/.well-known/oauth-protected-resource[/mcp]` | Découverte MCP/RFC 9728 |
| `/.well-known/oauth-authorization-server[/mcp]` | Métadonnées OAuth 2.1 (RFC 8414) |
| `/.well-known/openid-configuration[/mcp]` | Même document, pour les clients qui basculent sur la découverte OIDC |
| `/register` | Enregistrement dynamique du client (RFC 7591) |
| `/authorize` | Connexion et consentement utilisateur |
| `/token` | Échange et renouvellement des jetons |

Les variantes suffixées par `/mcp` existent parce que les clients sondent
`/.well-known/<suffixe>/mcp` **avant** de se rabattre sur la racine. Les anciens
chemins préfixés par `/oauth` restent acceptés pour compatibilité.

Les clients enregistrés et les refresh tokens sont écrits dans
`MCP_OAUTH_STATE_PATH` et survivent donc à un redéploiement : Claude conserve son
`client_id` indéfiniment, et le perdre casserait la connexion sans moyen de la
rétablir autrement qu'en supprimant puis réajoutant le serveur. Les access tokens
restent en mémoire (une heure de durée de vie, renouvelés automatiquement).

Ce fichier contient des secrets porteurs : il est écrit en `0600` et doit rester
sur un volume privé.

## Dépannage

**Claude ne parvient pas à se connecter.** Vérifier d'abord quel mode
d'authentification tourne réellement :

```bash
docker compose logs obsidian-mcp | grep -E "Authentication|OAuth"
```

- `🔐 Authentication: OAuth 2.1` → OAuth est actif.
- `⚠️  OAuth inactif — variables manquantes : …` → les variables ne sont pas arrivées
  dans le conteneur. Le `.env` doit être à côté du `docker-compose.yml` sur le
  serveur, puis `docker compose up -d --build` (un simple `restart` ne relit pas
  le `.env`).

Le test décisif, sans client :

```bash
curl -si -X POST https://mcp.example.fr/mcp -d '{}' -H 'Content-Type: application/json' \
  | grep -i www-authenticate
```

Cet en-tête est le seul point d'entrée de la découverte OAuth. S'il est absent,
aucun client ne peut trouver le serveur d'autorisation, et `/authorize` comme
`/register` répondront 404.
