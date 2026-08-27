import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const safeTestEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  MCP_AUTH_MODE: "none",
};

describe("loadConfig safety checks", () => {
  it("requires a public base URL when OAuth is enabled", () => {
    expect(() =>
      loadConfig({
        ...safeTestEnv,
        MCP_AUTH_MODE: "oauth",
      }),
    ).toThrow("PUBLIC_BASE_URL is required when MCP_AUTH_MODE=oauth");

    const config = loadConfig({
      ...safeTestEnv,
      MCP_AUTH_MODE: "oauth",
      PUBLIC_BASE_URL: "https://mcp.example.test/service/",
    });
    expect(config.publicBaseUrl?.href).toBe("https://mcp.example.test/service");
  });

  it("forbids unauthenticated production mode", () => {
    expect(() =>
      loadConfig({
        ...safeTestEnv,
        NODE_ENV: "production",
      }),
    ).toThrow("MCP_AUTH_MODE=none is forbidden in production");
  });

  it("requires latitude and longitude to be configured as a pair", () => {
    expect(() =>
      loadConfig({
        ...safeTestEnv,
        YANDEX_EATS_LATITUDE: "40.18",
      }),
    ).toThrow("YANDEX_EATS_LATITUDE and YANDEX_EATS_LONGITUDE must be configured together");

    expect(() =>
      loadConfig({
        ...safeTestEnv,
        YANDEX_EATS_LONGITUDE: "44.51",
      }),
    ).toThrow("YANDEX_EATS_LATITUDE and YANDEX_EATS_LONGITUDE must be configured together");

    const config = loadConfig({
      ...safeTestEnv,
      YANDEX_EATS_LATITUDE: "40.18",
      YANDEX_EATS_LONGITUDE: "44.51",
    });
    expect(config.eats.latitude).toBe(40.18);
    expect(config.eats.longitude).toBe(44.51);
  });
});
