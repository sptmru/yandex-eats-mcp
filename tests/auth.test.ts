import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SingleUserOAuthProvider, StaticBearerVerifier } from "../src/auth/single-user-oauth.js";
import { createLogger } from "../src/logger.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
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
});

