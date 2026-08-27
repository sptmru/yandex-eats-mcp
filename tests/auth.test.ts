import { mkdtemp, rm } from "node:fs/promises";
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
});

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
