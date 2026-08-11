import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";

const OAUTH_USERNAME = process.env.MCP_OAUTH_USERNAME;
const OAUTH_PASSWORD = process.env.MCP_OAUTH_PASSWORD;
const OAUTH_ISSUER = process.env.MCP_OAUTH_ISSUER?.replace(/\/$/, "");
const OAUTH_CLIENT_ID = process.env.MCP_OAUTH_CLIENT_ID;
const OAUTH_REDIRECT_URIS = process.env.MCP_OAUTH_REDIRECT_URIS?.split(",").map((uri) => uri.trim()).filter(Boolean);
const OAUTH_CLIENT_NAME = process.env.MCP_OAUTH_CLIENT_NAME;
const ACCESS_TOKEN_TTL_SECONDS = parsePositiveInt(process.env.MCP_OAUTH_ACCESS_TOKEN_TTL, 3600);
const REFRESH_TOKEN_TTL_SECONDS = parsePositiveInt(process.env.MCP_OAUTH_REFRESH_TOKEN_TTL, 60 * 60 * 24 * 30);
const SCOPES = ["obsidian.read", "obsidian.write"];

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

function requestedScope(value: unknown): string | undefined {
  const scope = typeof value === "string" && value.trim() ? value.trim() : SCOPES.join(" ");
  const values = scope.split(/\s+/);
  return values.every((item) => SCOPES.includes(item)) ? values.join(" ") : undefined;
}

function cleanup(): void {
  const now = Date.now();
  for (const collection of [pendingAuthorizations, authorizationCodes, accessTokens, refreshTokens]) {
    for (const [key, value] of collection) if (value.expiresAt <= now) collection.delete(key);
  }
}

function oauthError(res: Response, error: string, description: string, status = 400): void {
  res.status(status).json({ error, error_description: description });
}

function authorizationError(res: Response, redirectUri: string, error: string, state?: string): void {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  if (state) target.searchParams.set("state", state);
  res.redirect(303, target.toString());
}

function htmlPage(fields: Record<string, string>): string {
  const escape = (input: string) => input.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char] as string);
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Autoriser Obsidian MCP</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}label,input{display:block;width:100%;box-sizing:border-box;margin:.4rem 0}button{margin-top:1rem;padding:.6rem 1rem}</style></head><body><h1>Autoriser Obsidian MCP</h1><p>Vous autorisez <strong>${escape(fields.clientName)}</strong> à accéder à votre vault Obsidian.</p><form method="post" action="/authorize"><input type="hidden" name="request_id" value="${escape(fields.requestId)}"><label>Identifiant<input name="username" autocomplete="username" required></label><label>Mot de passe<input type="password" name="password" autocomplete="current-password" required></label><button type="submit">Autoriser</button></form></body></html>`;
}

export function isOAuthEnabled(): boolean {
  return Boolean(OAUTH_USERNAME && OAUTH_PASSWORD && OAUTH_ISSUER);
}

export function oauthConfigurationError(): string | undefined {
  const anyConfigured = Boolean(OAUTH_USERNAME || OAUTH_PASSWORD || OAUTH_ISSUER);
  if (anyConfigured && !isOAuthEnabled()) return "MCP_OAUTH_USERNAME, MCP_OAUTH_PASSWORD and MCP_OAUTH_ISSUER must be configured together";
  if (Boolean(OAUTH_CLIENT_ID) !== Boolean(OAUTH_REDIRECT_URIS?.length)) return "MCP_OAUTH_CLIENT_ID and MCP_OAUTH_REDIRECT_URIS must be configured together";
  if (OAUTH_REDIRECT_URIS && !OAUTH_REDIRECT_URIS.every(validRedirectUri)) return "MCP_OAUTH_REDIRECT_URIS contains an invalid redirect URI";
  return undefined;
}

export function requireOAuthToken(req: Request, res: Response): boolean {
  cleanup();
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const record = accessTokens.get(token);
  if (!record || record.expiresAt <= Date.now()) {
    const resourceMetadata = `${baseUrl(req)}/.well-known/oauth-protected-resource`;
    res.set("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadata}"`);
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

export function registerOAuthRoutes(app: Express): void {
  if (!isOAuthEnabled()) return;
  // Optional pre-registration supports clients such as Claude that are already
  // configured with a fixed client_id instead of dynamic registration.
  if (OAUTH_CLIENT_ID && OAUTH_REDIRECT_URIS) {
    clients.set(OAUTH_CLIENT_ID, { redirectUris: OAUTH_REDIRECT_URIS, clientName: OAUTH_CLIENT_NAME });
  }

  app.get("/.well-known/oauth-protected-resource", (req, res) => {
    const issuer = baseUrl(req);
    res.json({ resource: `${issuer}/mcp`, authorization_servers: [issuer], scopes_supported: SCOPES, bearer_methods_supported: ["header"] });
  });

  app.get("/.well-known/oauth-authorization-server", (req, res) => {
    const issuer = baseUrl(req);
    res.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: SCOPES });
  });

  app.post(["/register", "/oauth/register"], (req, res) => {
    const redirectUris = req.body?.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every(validRedirectUri)) {
      oauthError(res, "invalid_client_metadata", "redirect_uris must contain valid HTTPS URLs (or 127.0.0.1 HTTP URLs)");
      return;
    }
    const clientId = randomToken();
    clients.set(clientId, { redirectUris, clientName: typeof req.body.client_name === "string" ? req.body.client_name.slice(0, 120) : undefined });
    res.status(201).json({ client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: redirectUris, token_endpoint_auth_method: "none" });
  });

  app.get(["/authorize", "/oauth/authorize"], (req, res) => {
    cleanup();
    const { client_id: clientId, redirect_uri: redirectUri, response_type: responseType, state, code_challenge: challenge, code_challenge_method: method } = req.query;
    if (typeof clientId !== "string" || typeof redirectUri !== "string") return res.status(400).send("Invalid OAuth client or redirect URI");
    const client = clients.get(clientId);
    if (!client || !client.redirectUris.includes(redirectUri)) return res.status(400).send("Invalid OAuth client or redirect URI");
    if (responseType !== "code" || method !== "S256" || typeof challenge !== "string" || !challenge) return authorizationError(res, redirectUri, "invalid_request", typeof state === "string" ? state : undefined);
    const scope = requestedScope(req.query.scope);
    if (!scope) return authorizationError(res, redirectUri, "invalid_scope", typeof state === "string" ? state : undefined);
    const requestId = randomToken();
    pendingAuthorizations.set(requestId, { clientId, redirectUri, state: typeof state === "string" ? state : undefined, codeChallenge: challenge, scope, expiresAt: Date.now() + 10 * 60 * 1000 });
    res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'");
    res.type("html").send(htmlPage({ clientName: client.clientName ?? "un client OAuth", requestId }));
  });

  app.post(["/authorize", "/oauth/authorize"], (req, res) => {
    cleanup();
    const requestId = typeof req.body?.request_id === "string" ? req.body.request_id : "";
    const pending = pendingAuthorizations.get(requestId);
    pendingAuthorizations.delete(requestId);
    if (!pending) return res.status(400).send("Authorization request expired. Please restart the connection.");
    if (!equal(String(req.body?.username ?? ""), OAUTH_USERNAME!) || !equal(String(req.body?.password ?? ""), OAUTH_PASSWORD!)) return res.status(401).send("Invalid credentials. Please restart the connection.");
    const code = randomToken();
    authorizationCodes.set(code, { ...pending, expiresAt: Date.now() + 60 * 1000 });
    const target = new URL(pending.redirectUri);
    target.searchParams.set("code", code);
    if (pending.state) target.searchParams.set("state", pending.state);
    res.redirect(303, target.toString());
  });

  app.post(["/token", "/oauth/token"], (req, res) => {
    cleanup();
    const grantType = req.body?.grant_type;
    if (grantType === "authorization_code") {
      const code = typeof req.body.code === "string" ? req.body.code : "";
      const record = authorizationCodes.get(code);
      authorizationCodes.delete(code);
      if (!record || record.expiresAt <= Date.now() || req.body.client_id !== record.clientId || req.body.redirect_uri !== record.redirectUri) return oauthError(res, "invalid_grant", "Invalid or expired authorization code");
      const verifier = typeof req.body.code_verifier === "string" ? req.body.code_verifier : "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (!verifier || !equal(challenge, record.codeChallenge)) return oauthError(res, "invalid_grant", "PKCE verification failed");
      return sendTokens(res, record.clientId, record.scope);
    }
    if (grantType === "refresh_token") {
      const refreshToken = typeof req.body.refresh_token === "string" ? req.body.refresh_token : "";
      const record = refreshTokens.get(refreshToken);
      refreshTokens.delete(refreshToken);
      if (!record || record.expiresAt <= Date.now() || req.body.client_id !== record.clientId) return oauthError(res, "invalid_grant", "Invalid or expired refresh token");
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
  res.set("Cache-Control", "no-store").json({ access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_SECONDS, refresh_token: refreshToken, scope });
}
