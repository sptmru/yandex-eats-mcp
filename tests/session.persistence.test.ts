import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { EatsSession } from "../src/eats/session.js";
import { createLogger } from "../src/logger.js";

const writes = vi.hoisted(() => ({ intercept: undefined as ((path: unknown) => Promise<void>) | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      await writes.intercept?.(args[0]);
      return actual.writeFile(...args);
    },
  };
});

const directories: string[] = [];
afterEach(async () => {
  writes.intercept = undefined;
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Yandex session persistence", () => {
  it("serializes overlapping response saves so an older session cannot overwrite the latest one", async () => {
    const { session, directory } = await fixture();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    let saves = 0;
    writes.intercept = async (path) => {
      if (!String(path).includes("cookies.json.")) return;
      saves += 1;
      if (saves === 1) {
        notifyStarted();
        await firstBlocked;
      }
    };
    const older = session.absorbResponse(new Headers({ "x-eats-session": "old-session" }));
    await started;
    const newer = session.absorbResponse(new Headers({ "x-eats-session": "new-session" }));
    await setImmediate();
    try {
      expect(saves).toBe(1);
    } finally {
      releaseFirst();
      await Promise.all([older, newer]);
    }
    const saved = JSON.parse(await readFile(join(directory, "cookies.json"), "utf8")) as { eatsSession: string };
    expect(saved.eatsSession).toBe("new-session");
  });

  it("recovers from a failed cookie save on the next response", async () => {
    const { session, directory } = await fixture();
    const path = join(directory, "cookies.json");
    const backup = join(directory, "cookies.saved.json");
    await rename(path, backup);
    await mkdir(path);
    await expect(session.absorbResponse(new Headers({ "x-eats-session": "failed-save" }))).rejects.toThrow();
    await rm(path, { recursive: true });
    await rename(backup, path);
    await session.absorbResponse(new Headers({ "x-eats-session": "recovered-session" }));
    const saved = JSON.parse(await readFile(path, "utf8")) as { eatsSession: string };
    expect(saved.eatsSession).toBe("recovered-session");
  });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "yandex-eats-session-test-"));
  directories.push(directory);
  const cookieFile = join(directory, "cookie");
  await writeFile(cookieFile, "Session_id=session-value");
  const config = loadConfig({ NODE_ENV: "test", MCP_AUTH_MODE: "none", MCP_STATE_DIR: directory, YANDEX_EATS_COOKIE_FILE: cookieFile });
  const session = new EatsSession(config, createLogger("silent"));
  await session.initialize();
  return { session, directory };
}
