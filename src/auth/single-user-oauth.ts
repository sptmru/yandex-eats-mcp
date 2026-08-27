import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Request, Response } from "express";
import type { Logger } from "pino";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  AccessDeniedError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTHORIZATION_TTL_MS = 10 * 60 * 1_000;
const SUPPORTED_SCOPE = "mcp:tools";

type StoredToken = {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  kind: "access" | "refresh";
  resource: string;
};

type PersistedOAuthState = {
  clients: Record<string, OAuthClientInformationFull>;
  tokens: Record<string, StoredToken>;
};

type PendingAuthorization = {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expiresAt: number;
  failedAttempts: number;
  authorizationCode?: string;
};

type AuthorizationCode = PendingAuthorization;

export class SingleUserOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private state: PersistedOAuthState = { clients: {}, tokens: {} };
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private saveQueue = Promise.resolve();

  constructor(
    private readonly stateDir: string,
    private readonly password: string,
    private readonly resourceUrl: URL,
    private readonly logger: Logger,
  ) {
    this.clientsStore = {
      getClient: (clientId) => Promise.resolve(this.state.clients[clientId]),
      registerClient: async (input) => {
        const runtimeInput = input as OAuthClientInformationFull;
        const clientId = runtimeInput.client_id ?? randomUUID();
        const redirectUris = runtimeInput.redirect_uris.map((value) => String(value));
        if (redirectUris.some((value) => !isSafeRedirectUri(value))) {
          throw new InvalidRequestError("Only HTTPS or loopback redirect URIs are allowed");
        }
        const client: OAuthClientInformationFull = {
          ...runtimeInput,
          client_id: clientId,
          client_id_issued_at: runtimeInput.client_id_issued_at ?? Math.floor(Date.now() / 1000),
        };
        this.state.clients[clientId] = client;
        await this.persist();
        this.logger.info({ clientId, clientName: client.client_name }, "Registered MCP OAuth client");
        return client;
      },
    };
  }

  async initialize(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as Partial<PersistedOAuthState>;
      this.state = {
        clients: parsed.clients && typeof parsed.clients === "object" ? parsed.clients : {},
        tokens: parsed.tokens && typeof parsed.tokens === "object" ? parsed.tokens : {},
      };
    } catch {
      this.state = { clients: {}, tokens: {} };
    }
    this.pruneExpiredTokens();
    await this.persist();
  }

  authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.validateResource(params.resource);
    if (params.scopes?.some((scope) => scope !== SUPPORTED_SCOPE)) {
      throw new InvalidScopeError(`Only ${SUPPORTED_SCOPE} is supported`);
    }
    if (!client.redirect_uris.includes(params.redirectUri)) {
      throw new InvalidRequestError("Unregistered redirect URI");
    }
    const redirectOrigin = new URL(params.redirectUri).origin;
    this.pruneTransientState();
    const pendingId = secureToken();
    const pendingKey = hashToken(pendingId);
    this.pending.set(pendingKey, {
      client,
      params: { ...params, scopes: params.scopes?.length ? params.scopes : [SUPPORTED_SCOPE] },
      expiresAt: Date.now() + AUTHORIZATION_TTL_MS,
      failedAttempts: 0,
    });
    this.logger.info(
      {
        clientId: client.client_id,
        pendingFingerprint: fingerprintHash(pendingKey),
        pendingCount: this.pending.size,
        expiresInSeconds: AUTHORIZATION_TTL_MS / 1_000,
      },
      "Created MCP OAuth authorization request",
    );
    res
      .status(200)
      .set({
        "Cache-Control": "no-store",
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${redirectOrigin}; base-uri 'none'; frame-ancestors 'none'`,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      })
      .send(renderApprovalPage(pendingId, client.client_name ?? "ChatGPT"));
    return Promise.resolve();
  }

  approve(req: Request, res: Response): Promise<void> {
    const rawBody = req.body as unknown;
    const body = rawBody !== null && typeof rawBody === "object" ? (rawBody as Record<string, unknown>) : {};
    const pendingId = typeof body.pending === "string" ? body.pending : "";
    const suppliedPassword = typeof body.password === "string" ? body.password : "";
    const key = hashToken(pendingId);
    const pending = this.pending.get(key);
    if (!pending) {
      this.logger.warn(
        {
          ip: req.ip,
          pendingPresent: pendingId.length > 0,
          pendingFingerprint: pendingId.length > 0 ? fingerprintHash(key) : undefined,
          pendingCount: this.pending.size,
          reason: "missing",
        },
        "Rejected MCP OAuth approval request",
      );
      res.status(400).type("text/plain").send("Authorization request expired. Start the connection again.");
      return Promise.resolve();
    }
    const now = Date.now();
    if (pending.expiresAt < now) {
      this.pending.delete(key);
      if (pending.authorizationCode) this.codes.delete(hashToken(pending.authorizationCode));
      this.logger.warn(
        {
          ip: req.ip,
          pendingPresent: true,
          pendingFingerprint: fingerprintHash(key),
          pendingCount: this.pending.size,
          reason: "expired",
          ageMs: AUTHORIZATION_TTL_MS + now - pending.expiresAt,
        },
        "Rejected MCP OAuth approval request",
      );
      res.status(400).type("text/plain").send("Authorization request expired. Start the connection again.");
      return Promise.resolve();
    }
    if (!safeEqual(this.password, suppliedPassword)) {
      pending.failedAttempts += 1;
      if (pending.failedAttempts >= 5) this.pending.delete(key);
      this.logger.warn(
        {
          ip: req.ip,
          pendingFingerprint: fingerprintHash(key),
          failedAttempts: pending.failedAttempts,
        },
        "Rejected MCP OAuth approval password",
      );
      res.status(401).type("text/plain").send("Authorization was rejected. Start the connection again if needed.");
      return Promise.resolve();
    }
    if (pending.authorizationCode) {
      const authorizationCode = pending.authorizationCode;
      if (this.codes.has(hashToken(authorizationCode))) {
        this.logger.info(
          {
            ip: req.ip,
            clientId: pending.client.client_id,
            pendingFingerprint: fingerprintHash(key),
            ageMs: AUTHORIZATION_TTL_MS - Math.max(0, pending.expiresAt - now),
          },
          "Replayed MCP OAuth approval redirect",
        );
        redirectAuthorization(res, pending, authorizationCode);
      } else {
        this.logger.info(
          {
            ip: req.ip,
            clientId: pending.client.client_id,
            pendingFingerprint: fingerprintHash(key),
          },
          "Ignored duplicate MCP OAuth approval after code exchange",
        );
        res.status(200).type("text/plain").send("Authorization is already complete. You can return to ChatGPT.");
      }
      return Promise.resolve();
    }
    this.logger.info(
      {
        ip: req.ip,
        clientId: pending.client.client_id,
        pendingFingerprint: fingerprintHash(key),
        ageMs: AUTHORIZATION_TTL_MS - Math.max(0, pending.expiresAt - now),
      },
      "Approved MCP OAuth authorization request",
    );
    const code = secureToken();
    pending.authorizationCode = code;
    this.codes.set(hashToken(code), pending);
    redirectAuthorization(res, pending, code);
    return Promise.resolve();
  }

  challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const code = this.getCode(client, authorizationCode);
    this.logger.info(
      {
        clientId: client.client_id,
        authorizationCodeFingerprint: fingerprintHash(hashToken(authorizationCode)),
      },
      "Loaded MCP OAuth authorization code challenge",
    );
    return Promise.resolve(code.params.codeChallenge);
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const key = hashToken(authorizationCode);
    const code = this.getCode(client, authorizationCode);
    if (redirectUri && redirectUri !== code.params.redirectUri) {
      throw new InvalidGrantError("Authorization code redirect URI mismatch");
    }
    if (resource) this.validateResource(resource);
    this.codes.delete(key);
    this.logger.info(
      {
        clientId: client.client_id,
        authorizationCodeFingerprint: fingerprintHash(key),
      },
      "Exchanged MCP OAuth authorization code",
    );
    return this.issueTokenPair(client.client_id, code.params.scopes ?? [SUPPORTED_SCOPE]);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const key = hashToken(refreshToken);
    const stored = this.state.tokens[key];
    if (!stored || stored.kind !== "refresh" || stored.expiresAt < epochSeconds()) {
      delete this.state.tokens[key];
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    if (stored.clientId !== client.client_id) throw new InvalidGrantError("Refresh token client mismatch");
    if (resource) this.validateResource(resource);
    const requestedScopes = scopes?.length ? scopes : stored.scopes;
    if (requestedScopes.some((scope) => !stored.scopes.includes(scope))) {
      throw new InvalidScopeError("Refresh token cannot expand scopes");
    }
    delete this.state.tokens[key];
    return this.issueTokenPair(client.client_id, requestedScopes);
  }

  verifyAccessToken(token: string): Promise<AuthInfo> {
    const key = hashToken(token);
    const stored = this.state.tokens[key];
    if (!stored || stored.kind !== "access" || stored.expiresAt < epochSeconds()) {
      delete this.state.tokens[key];
      return Promise.reject(new AccessDeniedError("Invalid or expired access token"));
    }
    if (stored.resource !== this.resourceUrl.href) {
      return Promise.reject(new InvalidTargetError("Access token is not valid for this MCP resource"));
    }
    return Promise.resolve({
      token,
      clientId: stored.clientId,
      scopes: stored.scopes,
      expiresAt: stored.expiresAt,
      resource: this.resourceUrl,
      extra: { principal: "owner" },
    });
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const key = hashToken(request.token);
    if (this.state.tokens[key]?.clientId === client.client_id) delete this.state.tokens[key];
    await this.persist();
  }

  private getCode(client: OAuthClientInformationFull, rawCode: string): AuthorizationCode {
    const key = hashToken(rawCode);
    const code = this.codes.get(key);
    if (!code || code.expiresAt < Date.now()) {
      this.codes.delete(key);
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    if (code.client.client_id !== client.client_id) {
      throw new InvalidGrantError("Authorization code client mismatch");
    }
    return code;
  }

  private async issueTokenPair(clientId: string, scopes: string[]): Promise<OAuthTokens> {
    const accessToken = secureToken();
    const refreshToken = secureToken();
    this.state.tokens[hashToken(accessToken)] = {
      clientId,
      scopes,
      expiresAt: epochSeconds() + ACCESS_TOKEN_TTL_SECONDS,
      kind: "access",
      resource: this.resourceUrl.href,
    };
    this.state.tokens[hashToken(refreshToken)] = {
      clientId,
      scopes,
      expiresAt: epochSeconds() + REFRESH_TOKEN_TTL_SECONDS,
      kind: "refresh",
      resource: this.resourceUrl.href,
    };
    await this.persist();
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  private validateResource(resource?: URL): void {
    if (resource && normalizeUrl(resource) !== normalizeUrl(this.resourceUrl)) {
      throw new InvalidTargetError("Invalid MCP resource identifier");
    }
  }

  private pruneExpiredTokens(): void {
    const now = epochSeconds();
    for (const [key, token] of Object.entries(this.state.tokens)) {
      if (token.expiresAt < now) delete this.state.tokens[key];
    }
  }

  private pruneTransientState(): void {
    const now = Date.now();
    for (const [key, pending] of this.pending) if (pending.expiresAt < now) this.pending.delete(key);
    for (const [key, code] of this.codes) if (code.expiresAt < now) this.codes.delete(key);
  }

  private persist(): Promise<void> {
    this.saveQueue = this.saveQueue.then(async () => {
      const temporary = `${this.statePath}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(this.state), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.statePath);
    });
    return this.saveQueue;
  }

  private get statePath(): string {
    return join(this.stateDir, "oauth.json");
  }
}

export class StaticBearerVerifier {
  constructor(private readonly expectedToken: string) {}

  verifyAccessToken(token: string): Promise<AuthInfo> {
    if (!safeEqual(this.expectedToken, token)) {
      return Promise.reject(new AccessDeniedError("Invalid bearer token"));
    }
    return Promise.resolve({
      token,
      clientId: "single-user",
      scopes: [SUPPORTED_SCOPE],
      extra: { principal: "owner" },
    });
  }
}

function secureToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprintHash(hash: string): string {
  return hash.slice(0, 12);
}

function redirectAuthorization(res: Response, pending: PendingAuthorization, code: string): void {
  const target = new URL(pending.params.redirectUri);
  target.searchParams.set("code", code);
  if (pending.params.state) target.searchParams.set("state", pending.params.state);
  res.redirect(302, target.href);
}

function safeEqual(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function normalizeUrl(url: URL): string {
  const copy = new URL(url);
  copy.hash = "";
  return copy.href.replace(/\/$/, "");
}

function isSafeRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch {
    return false;
  }
}

function renderApprovalPage(pendingId: string, clientName: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Yandex Eats MCP</title>
<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:10vh auto;padding:1.5rem;color:#18181b}label,input,button{display:block;width:100%;box-sizing:border-box}input,button{font:inherit;padding:.8rem;margin-top:.5rem}button{margin-top:1rem;background:#111827;color:white;border:0;border-radius:.4rem}small{color:#52525b}</style></head>
<body><h1>Authorize Yandex Eats MCP</h1><p><strong>${escapeHtml(clientName)}</strong> is requesting access to the private food-ordering tools on this server.</p>
<p><small>This grants search and cart access. Final checkout and order placement are disabled.</small></p>
<form method="post" action="/oauth/approve"><input type="hidden" name="pending" value="${escapeHtml(pendingId)}"><label>Owner password<input type="password" name="password" autocomplete="current-password" required></label><button type="submit">Authorize</button></form></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
