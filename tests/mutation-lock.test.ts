import { describe, expect, it } from "vitest";

import { MutationLock } from "../src/security/mutation-lock.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("MutationLock", () => {
  it("serializes operations that use the same cart key", async () => {
    const lock = new MutationLock();
    const firstGate = deferred();
    const firstStarted = deferred();
    const events: string[] = [];

    const first = lock.run("cart:cafe-one", async () => {
      events.push("first:start");
      firstStarted.resolve();
      await firstGate.promise;
      events.push("first:end");
      return "first";
    });

    await firstStarted.promise;
    const second = lock.run("cart:cafe-one", () => {
      events.push("second:start");
      events.push("second:end");
      return Promise.resolve("second");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    firstGate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("releases the queue when an operation fails", async () => {
    const lock = new MutationLock();

    await expect(
      lock.run("cart:cafe-one", () => Promise.reject(new Error("mutation failed"))),
    ).rejects.toThrow("mutation failed");

    await expect(
      lock.run("cart:cafe-one", () => Promise.resolve("recovered")),
    ).resolves.toBe("recovered");
  });
});
