import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SingleUserOAuthProvider, StaticBearerVerifier } from "../src/auth/single-user-oauth.js";
import { createLogger } from "../src/logger.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("MCP authentication", () => {
  it("uses constant-time static bearer verification semantics", async () => {
    const verifier = new StaticBearerVerifier("a-long-random-secret");
    await expect(verifier.verifyAccessToken("a-long-random-secret")).resolves.toMatchObject({
      clientId: "single-user",
      scopes: ["mcp:tools"],
    });
    await expect(verifier.verifyAccessToken("wrong-secret")).rejects.toThrow("Invalid bearer token");
  });

  it("persists dynamically registered OAuth clients without storing owner credentials in client data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yandex-eats-mcp-oauth-"));
    temporaryDirectories.push(directory);
    const resource = new URL("https://eats-mcp.example.com/mcp");
    const first = new SingleUserOAuthProvider(directory, "owner-password", resource, createLogger("silent"));
    await first.initialize();
    const registered = await first.clientsStore.registerClient?.({
      redirect_uris: ["https://chatgpt.com/connector/callback"],
      token_endpoint_auth_method: "none",
      client_name: "ChatGPT",
    });
    expect(registered?.client_id).toBeTruthy();

    const second = new SingleUserOAuthProvider(directory, "different-runtime-password", resource, createLogger("silent"));
    await second.initialize();
    const restored = registered ? await second.clientsStore.getClient(registered.client_id) : undefined;
    expect(restored).toMatchObject({ client_name: "ChatGPT" });
    expect(JSON.stringify(restored)).not.toContain("owner-password");
  });

  it("logs safe diagnostics when an OAuth approval has no matching pending request", async () => {
    const fixture = await oauthFixture();
    const authorizationResponse = responseCapture();
    await fixture.provider.authorize(fixture.client, fixture.params, authorizationResponse.response);
    const pendingId = /name="pending" value="([^"]+)"/.exec(String(authorizationResponse.capture.body))?.[1];
    expect(pendingId).toBeTruthy();

    const approvalResponse = responseCapture();
    await fixture.provider.approve(
      { body: { password: "owner-password" }, ip: "127.0.0.1" } as Request,
      approvalResponse.response,
    );

    expect(approvalResponse.capture.statusCode).toBe(400);
    const missingRecord = fixture.records.find(
      (record) => record.level === "warn" && record.message === "Rejected MCP OAuth approval request",
    );
    expect(missingRecord?.bindings).toMatchObject({ reason: "missing", pendingPresent: false, pendingCount: 1 });
    const serialized = JSON.stringify(fixture.records);
    expect(serialized).not.toContain("owner-password");
    expect(serialized).not.toContain(pendingId);
  });

  it("distinguishes an expired OAuth approval from a missing request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T09:00:00Z"));
    const fixture = await oauthFixture();
    const authorizationResponse = responseCapture();
    await fixture.provider.authorize(fixture.client, fixture.params, authorizationResponse.response);
    const pendingId = /name="pending" value="([^"]+)"/.exec(String(authorizationResponse.capture.body))?.[1];
    expect(pendingId).toBeTruthy();

    vi.setSystemTime(new Date("2026-08-27T09:10:01Z"));
    const approvalResponse = responseCapture();
    await fixture.provider.approve(
      {
        body: { pending: pendingId, password: "owner-password" },
        ip: "127.0.0.1",
      } as Request,
      approvalResponse.response,
    );

    expect(approvalResponse.capture.statusCode).toBe(400);
    const expiredRecord = fixture.records.find(
      (record) => record.level === "warn" && record.message === "Rejected MCP OAuth approval request",
    );
    expect(expiredRecord?.bindings).toMatchObject({ reason: "expired", pendingPresent: true, ageMs: 601_000 });
  });

  it("replays the same redirect when a browser submits an OAuth approval twice", async () => {
    const fixture = await oauthFixture();
    const authorizationResponse = responseCapture();
    await fixture.provider.authorize(fixture.client, fixture.params, authorizationResponse.response);
    const pendingId = /name="pending" value="([^"]+)"/.exec(String(authorizationResponse.capture.body))?.[1];
    expect(pendingId).toBeTruthy();
    const request = {
      body: { pending: pendingId, password: "owner-password" },
      ip: "127.0.0.1",
    } as Request;

    const firstApproval = responseCapture();
    await fixture.provider.approve(request, firstApproval.response);
    const duplicateApproval = responseCapture();
    await fixture.provider.approve(request, duplicateApproval.response);

    expect(firstApproval.capture.statusCode).toBe(302);
    expect(duplicateApproval.capture.statusCode).toBe(302);
    expect(duplicateApproval.capture.location).toBe(firstApproval.capture.location);
    expect(fixture.records).toContainEqual(
      expect.objectContaining({
        level: "info",
        message: "Replayed MCP OAuth approval redirect",
      }),
    );
  });

  it("recovers after a failed save without exposing or later persisting the failed registration", async () => {
    const fixture = await oauthFixture();
    const restore = await blockOAuthSave(fixture.directory);
    const failedClient = {
      client_id: "failed-client",
      redirect_uris: fixture.client.redirect_uris,
      token_endpoint_auth_method: "none" as const,
    };
    await expect(fixture.provider.clientsStore.registerClient?.(failedClient)).rejects.toThrow();
    expect(await fixture.provider.clientsStore.getClient("failed-client")).toBeUndefined();
    await restore();

    const registered = await fixture.provider.clientsStore.registerClient?.({
      redirect_uris: fixture.client.redirect_uris,
      token_endpoint_auth_method: "none",
    });
    expect(registered?.client_id).toBeTruthy();
    const saved = JSON.parse(await readFile(join(fixture.directory, "oauth.json"), "utf8")) as { clients: Record<string, unknown> };
    expect(saved.clients[fixture.client.client_id]).toBeDefined();
    expect(saved.clients["failed-client"]).toBeUndefined();
    expect(Object.keys(saved.clients)).toHaveLength(2);
  });

  it.each(["{broken-json", '{"clients":[],"tokens":{}}', '{"clients":{},"tokens":{"hash":{"kind":"access"}}}'])(
    "preserves corrupt OAuth state instead of replacing it (%s)",
    async (contents) => {
      const directory = await mkdtemp(join(tmpdir(), "yandex-eats-mcp-oauth-invalid-"));
      temporaryDirectories.push(directory);
      const statePath = join(directory, "oauth.json");
      await writeFile(statePath, contents);
      const provider = new SingleUserOAuthProvider(directory, "owner-password", new URL("https://eats-mcp.example.com/mcp"), createLogger("silent"));
      await expect(provider.initialize()).rejects.toThrow("existing file was preserved");
      expect(await readFile(statePath, "utf8")).toBe(contents);
    },
  );

  it("keeps authorization codes usable after a failed token save and consumes them exactly once", async () => {
    const fixture = await oauthFixture();
    const code = await approveCode(fixture);
    const restore = await blockOAuthSave(fixture.directory);
    await expect(fixture.provider.exchangeAuthorizationCode(fixture.client, code)).rejects.toThrow();
    await expect(fixture.provider.challengeForAuthorizationCode(fixture.client, code)).resolves.toBe(fixture.params.codeChallenge);
    await restore();
    const exchanges = await Promise.allSettled([
      fixture.provider.exchangeAuthorizationCode(fixture.client, code),
      fixture.provider.exchangeAuthorizationCode(fixture.client, code),
    ]);
    expect(exchanges.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(exchanges.filter((result) => result.status === "rejected")).toHaveLength(1);
    const saved = JSON.parse(await readFile(join(fixture.directory, "oauth.json"), "utf8")) as { tokens: Record<string, unknown> };
    expect(Object.keys(saved.tokens)).toHaveLength(2);
  });

  it("preserves refresh tokens on a failed rotation and serializes concurrent rotations", async () => {
    const fixture = await oauthFixture();
    const code = await approveCode(fixture);
    const pair = await fixture.provider.exchangeAuthorizationCode(fixture.client, code);
    if (!pair.refresh_token) throw new Error("Missing refresh token");
    const restore = await blockOAuthSave(fixture.directory);
    await expect(fixture.provider.exchangeRefreshToken(fixture.client, pair.refresh_token)).rejects.toThrow();
    await expect(fixture.provider.verifyAccessToken(pair.access_token)).resolves.toMatchObject({ clientId: fixture.client.client_id });
    await restore();

    const exchanges = await Promise.allSettled([
      fixture.provider.exchangeRefreshToken(fixture.client, pair.refresh_token),
      fixture.provider.exchangeRefreshToken(fixture.client, pair.refresh_token),
    ]);
    expect(exchanges.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(exchanges.filter((result) => result.status === "rejected")).toHaveLength(1);
    const restored = new SingleUserOAuthProvider(fixture.directory, "owner-password", fixture.params.resource, createLogger("silent"));
    await restored.initialize();
    const successful = exchanges.find((result) => result.status === "fulfilled");
    if (successful?.status !== "fulfilled") throw new Error("Missing successful rotation");
    await expect(restored.verifyAccessToken(successful.value.access_token)).resolves.toMatchObject({ clientId: fixture.client.client_id });
  });
});

async function blockOAuthSave(directory: string): Promise<() => Promise<void>> {
  const path = join(directory, "oauth.json");
  const backup = join(directory, "oauth.saved.json");
  await rename(path, backup);
  await mkdir(path);
  return async () => {
    await rm(path, { recursive: true });
    await rename(backup, path);
  };
}

async function approveCode(fixture: Awaited<ReturnType<typeof oauthFixture>>): Promise<string> {
  const authorization = responseCapture();
  await fixture.provider.authorize(fixture.client, fixture.params, authorization.response);
  const pending = /name="pending" value="([^"]+)"/.exec(String(authorization.capture.body))?.[1];
  const approval = responseCapture();
  await fixture.provider.approve({ body: { pending, password: "owner-password" }, ip: "127.0.0.1" } as Request, approval.response);
  const code = new URL(approval.capture.location ?? "https://invalid.test").searchParams.get("code");
  if (!code) throw new Error("Missing authorization code");
  return code;
}

type CapturedLog = {
  level: "info" | "warn";
  bindings: Record<string, unknown>;
  message: string;
};

function captureLogger(): { logger: Logger; records: CapturedLog[] } {
  const records: CapturedLog[] = [];
  const record = (level: CapturedLog["level"], bindings: Record<string, unknown>, message: string): void => {
    records.push({ level, bindings, message });
  };
  return {
    logger: {
      info: (bindings: Record<string, unknown>, message: string) => record("info", bindings, message),
      warn: (bindings: Record<string, unknown>, message: string) => record("warn", bindings, message),
    } as unknown as Logger,
    records,
  };
}

function responseCapture(): {
  response: Response;
  capture: { statusCode?: number; body?: unknown; location?: string };
} {
  const capture: { statusCode?: number; body?: unknown; location?: string } = {};
  const response = {
    status: (statusCode: number) => {
      capture.statusCode = statusCode;
      return response;
    },
    set: () => response,
    type: () => response,
    send: (body: unknown) => {
      capture.body = body;
      return response;
    },
    redirect: (statusCode: number, location: string) => {
      capture.statusCode = statusCode;
      capture.location = location;
      return response;
    },
  };
  return { response: response as unknown as Response, capture };
}

async function oauthFixture(): Promise<{
  directory: string;
  provider: SingleUserOAuthProvider;
  client: NonNullable<Awaited<ReturnType<NonNullable<SingleUserOAuthProvider["clientsStore"]["registerClient"]>>>>;
  params: {
    state: string;
    scopes: string[];
    codeChallenge: string;
    redirectUri: string;
    resource: URL;
  };
  records: CapturedLog[];
}> {
  const directory = await mkdtemp(join(tmpdir(), "yandex-eats-mcp-oauth-diagnostics-"));
  temporaryDirectories.push(directory);
  const resource = new URL("https://eats-mcp.example.com/mcp");
  const { logger, records } = captureLogger();
  const provider = new SingleUserOAuthProvider(directory, "owner-password", resource, logger);
  await provider.initialize();
  const client = await provider.clientsStore.registerClient?.({
    redirect_uris: ["https://chatgpt.com/connector/callback"],
    token_endpoint_auth_method: "none",
    client_name: "ChatGPT",
  });
  if (!client) throw new Error("OAuth client registration is unavailable");
  records.length = 0;
  return {
    directory,
    provider,
    client,
    params: {
      state: "diagnostic-state",
      scopes: ["mcp:tools"],
      codeChallenge: "a".repeat(43),
      redirectUri: "https://chatgpt.com/connector/callback",
      resource,
    },
    records,
  };
}
