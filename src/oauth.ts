import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";

const OAUTH_USERNAME = process.env.MCP_OAUTH_USERNAME;
const OAUTH_PASSWORD = process.env.MCP_OAUTH_PASSWORD;
const OAUTH_ISSUER = process.env.MCP_OAUTH_ISSUER?.replace(/\/$/, "");
const OAUTH_CLIENT_ID = process.env.MCP_OAUTH_CLIENT_ID;
const OAUTH_REDIRECT_URIS = process.env.MCP_OAUTH_REDIRECT_URIS?.split(",").map((uri) => uri.trim()).filter(Boolean);
const OAUTH_CLIENT_NAME = process.env.MCP_OAUTH_CLIENT_NAME;
const ACCESS_TOKEN_TTL_SECONDS = parsePositiveInt(process.env.MCP_OAUTH_ACCESS_TOKEN_TTL, 3600);
const REFRESH_TOKEN_TTL_SECONDS = parsePositiveInt(process.env.MCP_OAUTH_REFRESH_TOKEN_TTL, 60 * 60 * 24 * 30);
const STATE_PATH = process.env.MCP_OAUTH_STATE_PATH || "/data/oauth-state.json";
const SCOPES = ["obsidian.read", "obsidian.write"];
const MAX_PASSWORD_ATTEMPTS = 3;
const REQUIRED_VARIABLES = ["MCP_OAUTH_ISSUER", "MCP_OAUTH_USERNAME", "MCP_OAUTH_PASSWORD"] as const;

interface Client {
  redirectUris: string[];
  clientName?: string;
}

interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scope: string;
  attempts: number;
  expiresAt: number;
}

interface AuthorizationCode extends PendingAuthorization {
  expiresAt: number;
}

interface Token {
  clientId: string;
  scope: string;
  expiresAt: number;
}

const clients = new Map<string, Client>();
const pendingAuthorizations = new Map<string, PendingAuthorization>();
const authorizationCodes = new Map<string, AuthorizationCode>();
const accessTokens = new Map<string, Token>();
const refreshTokens = new Map<string, Token>();

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function baseUrl(req: Request): string {
  // The externally visible URL must be explicit; accepting Host would make OAuth
  // metadata vulnerable to Host-header injection behind a reverse proxy.
  if (!OAUTH_ISSUER) throw new Error("MCP_OAUTH_ISSUER is not configured");
  return OAUTH_ISSUER;
}

function validRedirectUri(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

function requestedScope(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return SCOPES.join(" ");
  // Unknown scopes are dropped rather than rejected. Claude asks for extras such as
  // `offline_access`, and answering invalid_scope aborts the whole connection instead
  // of degrading to the scopes this server actually has.
  const granted = value.trim().split(/\s+/).filter((item) => SCOPES.includes(item));
  return granted.length ? granted.join(" ") : SCOPES.join(" ");
}

// Clients and refresh tokens outlive the process: Claude stores its client_id and
// refresh token permanently, so losing them on redeploy leaves the connector pointing
// at a client this server no longer knows, with no way to recover but a manual reset.
interface PersistedState {
  clients?: Array<[string, Client]>;
  refreshTokens?: Array<[string, Token]>;
}

function loadState(): void {
  let raw: string;
  try {
    raw = readFileSync(STATE_PATH, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`⚠️  OAuth state unreadable at ${STATE_PATH}: ${(err as Error).message}`);
    }
    return;
  }
  try {
    const parsed = JSON.parse(raw) as PersistedState;
    const now = Date.now();
    for (const [id, client] of parsed.clients ?? []) clients.set(id, client);
    for (const [token, record] of parsed.refreshTokens ?? []) if (record.expiresAt > now) refreshTokens.set(token, record);
  } catch (err) {
    console.error(`⚠️  OAuth state corrupt at ${STATE_PATH}, starting empty: ${(err as Error).message}`);
  }
}

// Written synchronously: the events that change this state are rare (a registration,
// or one token exchange per hour per client) and a deferred write can be lost to
// SIGTERM, which is exactly the redeploy case this persistence exists to survive.
function persistState(): void {
  const state: PersistedState = { clients: [...clients], refreshTokens: [...refreshTokens] };
  try {
    mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const temporary = `${STATE_PATH}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporary, STATE_PATH);
  } catch (err) {
    console.error(`⚠️  OAuth state could not be saved to ${STATE_PATH}: ${(err as Error).message}`);
  }
}

function cleanup(): void {
  const now = Date.now();
  let expiredRefreshToken = false;
  for (const collection of [pendingAuthorizations, authorizationCodes, accessTokens, refreshTokens]) {
    for (const [key, value] of collection) {
      if (value.expiresAt > now) continue;
      collection.delete(key);
      if (collection === refreshTokens) expiredRefreshToken = true;
    }
  }
  if (expiredRefreshToken) persistState();
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char] as string);
}

function oauthError(res: Response, error: string, description: string, status = 400): void {
  console.error(`OAuth /token error: ${error} — ${description}`);
  res.status(status).json({ error, error_description: description });
}

function authorizationError(res: Response, redirectUri: string, error: string, state?: string): void {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  if (state !== undefined) target.searchParams.set("state", state);
  // Top-level breakout: Claude often embeds /authorize in an iframe/webview; a bare
  // 303 would only navigate the iframe and leave the parent spinner hanging.
  redirectUserAgent(res, target.toString());
}

/** Navigate the top-level window to the client redirect (iframe/webview safe). */
function redirectUserAgent(res: Response, url: string): void {
  const safeUrl = escapeHtml(url);
  res
    .status(200)
    .set(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
    )
    .type("html")
    .send(
      `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${safeUrl}"><title>Redirection…</title><script>window.top.location.replace(${JSON.stringify(url)});</script></head><body><p>Redirection en cours… <a href="${safeUrl}">Continuer</a></p></body></html>`
    );
}

function htmlPage(fields: { clientName: string; requestId: string; error?: string }): string {
  const error = fields.error ? `<p role="alert" style="color:#b00020"><strong>${escapeHtml(fields.error)}</strong></p>` : "";
  // action uses the public issuer (not a relative URL) so a reverse-proxy path rewrite
  // cannot POST to the wrong host; target=_top escapes Claude's iframe/webview.
  const action = `${OAUTH_ISSUER}/authorize`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Autoriser Obsidian MCP</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}label,input{display:block;width:100%;box-sizing:border-box;margin:.4rem 0}button{margin-top:1rem;padding:.6rem 1rem}</style></head><body><h1>Autoriser Obsidian MCP</h1><p>Vous autorisez <strong>${escapeHtml(fields.clientName)}</strong> à accéder à votre vault Obsidian.</p>${error}<form method="post" action="${escapeHtml(action)}" target="_top"><input type="hidden" name="request_id" value="${escapeHtml(fields.requestId)}"><label>Identifiant<input name="username" autocomplete="username" required></label><label>Mot de passe<input type="password" name="password" autocomplete="current-password" required></label><button type="submit">Autoriser</button></form></body></html>`;
}

export function isOAuthEnabled(): boolean {
  return Boolean(OAUTH_USERNAME && OAUTH_PASSWORD && OAUTH_ISSUER);
}

/** Names of the variables that keep OAuth from starting, for startup diagnostics. */
export function missingOAuthVariables(): string[] {
  return REQUIRED_VARIABLES.filter((name) => !process.env[name]);
}

export function oauthConfigurationError(): string | undefined {
  const anyConfigured = Boolean(OAUTH_USERNAME || OAUTH_PASSWORD || OAUTH_ISSUER);
  if (anyConfigured && !isOAuthEnabled()) return "MCP_OAUTH_USERNAME, MCP_OAUTH_PASSWORD and MCP_OAUTH_ISSUER must be configured together";
  if (Boolean(OAUTH_CLIENT_ID) !== Boolean(OAUTH_REDIRECT_URIS?.length)) return "MCP_OAUTH_CLIENT_ID and MCP_OAUTH_REDIRECT_URIS must be configured together";
  if (OAUTH_REDIRECT_URIS && !OAUTH_REDIRECT_URIS.every(validRedirectUri)) return "MCP_OAUTH_REDIRECT_URIS contains an invalid redirect URI";
  // OAuth 2.1 §1.5 requires HTTPS for every endpoint; loopback stays allowed for local runs.
  if (OAUTH_ISSUER && !validRedirectUri(OAUTH_ISSUER)) return "MCP_OAUTH_ISSUER must be an https:// URL (or http://127.0.0.1 locally)";
  return undefined;
}

export function requireOAuthToken(req: Request, res: Response): boolean {
  cleanup();
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const record = accessTokens.get(token);
  if (!record || record.expiresAt <= Date.now()) {
    // RFC 9728 §5.1: the challenge is how a client with no prior knowledge finds the
    // authorization server, so it must carry the resource metadata URL.
    const challenge = [
      `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`,
      `scope="${SCOPES.join(" ")}"`,
    ];
    if (token) challenge.push('error="invalid_token"');
    res.set("WWW-Authenticate", challenge.join(", "));
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

export function registerOAuthRoutes(app: Express): void {
  if (!isOAuthEnabled()) return;
  loadState();
  // Optional pre-registration supports clients such as Claude that are already
  // configured with a fixed client_id instead of dynamic registration.
  if (OAUTH_CLIENT_ID && OAUTH_REDIRECT_URIS) {
    clients.set(OAUTH_CLIENT_ID, { redirectUris: OAUTH_REDIRECT_URIS, clientName: OAUTH_CLIENT_NAME });
  }

  // Both the root and the MCP-endpoint-scoped paths are served: clients probe
  // `/.well-known/<suffix>/mcp` before falling back to the root.
  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (req, res) => {
    const issuer = baseUrl(req);
    res.json({ resource: `${issuer}/mcp`, authorization_servers: [issuer], scopes_supported: SCOPES, bearer_methods_supported: ["header"] });
  });

  app.get(
    [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/mcp",
      // Clients that fall through to OpenID Connect discovery get the same document;
      // `code_challenge_methods_supported` must be present or they refuse to proceed.
      "/.well-known/openid-configuration",
      "/.well-known/openid-configuration/mcp",
    ],
    (req, res) => {
      const issuer = baseUrl(req);
      res.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: SCOPES,
      });
    }
  );

  app.post(["/register", "/oauth/register"], (req, res) => {
    const redirectUris = req.body?.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every(validRedirectUri)) {
      oauthError(res, "invalid_client_metadata", "redirect_uris must contain valid HTTPS URLs (or 127.0.0.1 HTTP URLs)");
      return;
    }
    const clientId = randomToken();
    const clientName = typeof req.body.client_name === "string" ? req.body.client_name.slice(0, 120) : undefined;
    clients.set(clientId, { redirectUris, clientName });
    persistState();
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      // 0 means "never expires"; clients that read this field treat a missing value
      // as a reason to re-register on every connection.
      client_id_expires_at: 0,
      redirect_uris: redirectUris,
      client_name: clientName,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPES.join(" "),
    });
  });

  app.get(["/authorize", "/oauth/authorize"], (req, res) => {
    cleanup();
    const { client_id: clientId, redirect_uri: redirectUri, response_type: responseType, state, code_challenge: challenge, code_challenge_method: method } = req.query;
    if (typeof clientId !== "string" || typeof redirectUri !== "string") return res.status(400).send("Invalid OAuth client or redirect URI");
    const client = clients.get(clientId);
    if (!client || !client.redirectUris.includes(redirectUri)) return res.status(400).send("Invalid OAuth client or redirect URI");
    if (responseType !== "code" || method !== "S256" || typeof challenge !== "string" || !challenge) return authorizationError(res, redirectUri, "invalid_request", typeof state === "string" ? state : undefined);
    const scope = requestedScope(req.query.scope);
    const requestId = randomToken();
    pendingAuthorizations.set(requestId, { clientId, redirectUri, state: typeof state === "string" ? state : undefined, codeChallenge: challenge, scope, attempts: 0, expiresAt: Date.now() + 10 * 60 * 1000 });
    res.set(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${OAUTH_ISSUER}; base-uri 'none'`
    );
    res.type("html").send(htmlPage({ clientName: client.clientName ?? "un client OAuth", requestId }));
  });

  app.post(["/authorize", "/oauth/authorize"], (req, res) => {
    cleanup();
    const requestId = typeof req.body?.request_id === "string" ? req.body.request_id : "";
    const pending = pendingAuthorizations.get(requestId);
    if (!pending) return res.status(400).send("Authorization request expired. Please restart the connection.");
    if (!equal(String(req.body?.username ?? ""), OAUTH_USERNAME!) || !equal(String(req.body?.password ?? ""), OAUTH_PASSWORD!)) {
      // A mistyped password re-renders the form instead of discarding the request:
      // otherwise the only recovery is restarting the flow from the client.
      pending.attempts += 1;
      if (pending.attempts >= MAX_PASSWORD_ATTEMPTS) {
        pendingAuthorizations.delete(requestId);
        return res.status(401).send("Too many failed attempts. Please restart the connection.");
      }
      const client = clients.get(pending.clientId);
      res.set(
        "Content-Security-Policy",
        `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${OAUTH_ISSUER}; base-uri 'none'`
      );
      return res.status(401).type("html").send(htmlPage({ clientName: client?.clientName ?? "un client OAuth", requestId, error: "Identifiant ou mot de passe incorrect." }));
    }
    pendingAuthorizations.delete(requestId);
    const code = randomToken();
    authorizationCodes.set(code, { ...pending, expiresAt: Date.now() + 5 * 60 * 1000 });
    const target = new URL(pending.redirectUri);
    target.searchParams.set("code", code);
    if (pending.state !== undefined) target.searchParams.set("state", pending.state);
    console.error(`OAuth: authorization code issued for client ${pending.clientId}`);
    redirectUserAgent(res, target.toString());
  });

  app.post(["/token", "/oauth/token"], (req, res) => {
    cleanup();
    const grantType = req.body?.grant_type;
    if (grantType === "authorization_code") {
      const code = typeof req.body.code === "string" ? req.body.code : "";
      const record = authorizationCodes.get(code);
      authorizationCodes.delete(code);
      if (!record || record.expiresAt <= Date.now() || req.body.client_id !== record.clientId || req.body.redirect_uri !== record.redirectUri) {
        return oauthError(res, "invalid_grant", "Invalid or expired authorization code");
      }
      const verifier = typeof req.body.code_verifier === "string" ? req.body.code_verifier : "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (!verifier || !equal(challenge, record.codeChallenge)) return oauthError(res, "invalid_grant", "PKCE verification failed");
      console.error(`OAuth: access token issued (authorization_code) for client ${record.clientId}`);
      return sendTokens(res, record.clientId, record.scope);
    }
    if (grantType === "refresh_token") {
      const refreshToken = typeof req.body.refresh_token === "string" ? req.body.refresh_token : "";
      const record = refreshTokens.get(refreshToken);
      if (!record || record.expiresAt <= Date.now() || req.body.client_id !== record.clientId) {
        return oauthError(res, "invalid_grant", "Invalid or expired refresh token");
      }
      // OAuth 2.1 §4.3.1 requires rotation for public clients.
      refreshTokens.delete(refreshToken);
      console.error(`OAuth: access token issued (refresh_token) for client ${record.clientId}`);
      return sendTokens(res, record.clientId, record.scope);
    }
    oauthError(res, "unsupported_grant_type", "Only authorization_code and refresh_token are supported");
  });
}

function sendTokens(res: Response, clientId: string, scope: string): void {
  const now = Date.now();
  const accessToken = randomToken();
  const refreshToken = randomToken();
  accessTokens.set(accessToken, { clientId, scope, expiresAt: now + ACCESS_TOKEN_TTL_SECONDS * 1000 });
  refreshTokens.set(refreshToken, { clientId, scope, expiresAt: now + REFRESH_TOKEN_TTL_SECONDS * 1000 });
  persistState();
  res.set("Cache-Control", "no-store").json({ access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_SECONDS, refresh_token: refreshToken, scope });
}
