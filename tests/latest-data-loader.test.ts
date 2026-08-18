import { describe, expect, it, vi } from "vitest";
import { createLatestDataLoader } from "../src/client/latest-data-loader.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("latest data loader", () => {
  it("runs a fresh read after an in-flight read before resolving reload", async () => {
    const first = deferred();
    const second = deferred();
    const fetchLatest = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { load, reload } = createLatestDataLoader(fetchLatest);

    const initialLoad = load("visible");
    const latestLoad = reload("silent");
    expect(fetchLatest).toHaveBeenCalledTimes(1);

    first.resolve();
    await initialLoad;
    await vi.waitFor(() => expect(fetchLatest).toHaveBeenCalledTimes(2));
    expect(fetchLatest).toHaveBeenLastCalledWith("silent");

    second.resolve();
    await latestLoad;
  });

  it("still starts a fresh read when the earlier background read fails", async () => {
    const first = deferred();
    const fetchLatest = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(undefined);
    const { load, reload } = createLatestDataLoader(fetchLatest);

    const initialLoad = load();
    const latestLoad = reload();
    first.reject(new Error("background request failed"));

    await expect(initialLoad).rejects.toThrow("background request failed");
    await expect(latestLoad).resolves.toBeUndefined();
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });
});
