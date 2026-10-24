import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveSessionsCache,
  clearAllCaches,
  clearAllSessionsQueryCache,
  getActiveSessionsCache,
  getOrLoadActiveSessionsCache,
  setActiveSessionsCache,
} from "@/lib/cache/session-cache";

type SessionRows = Parameters<typeof setActiveSessionsCache>[0];

function deferredRows() {
  let resolve!: (rows: SessionRows) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<SessionRows>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => clearAllCaches());

describe("monitoring query coalescing", () => {
  it("shares a pending load and retains the existing TTL cache", async () => {
    const deferred = deferredRows();
    const loader = vi.fn(() => deferred.promise);
    const first = getOrLoadActiveSessionsCache("all_sessions", loader);
    const second = getOrLoadActiveSessionsCache("all_sessions", loader);
    expect(first).toBe(second);
    await Promise.resolve();
    expect(loader).toHaveBeenCalledTimes(1);
    const rows: SessionRows = [];
    deferred.resolve(rows);
    expect(await first).toBe(rows);
    expect(await getOrLoadActiveSessionsCache("all_sessions", loader)).toBe(rows);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("releases failed loads so subsequent callers can retry", async () => {
    const deferred = deferredRows();
    const first = getOrLoadActiveSessionsCache("all_sessions", () => deferred.promise);
    const failure = expect(first).rejects.toThrow("query failed");
    deferred.reject(new Error("query failed"));
    await failure;
    const loader = vi.fn(async () => []);
    expect(await getOrLoadActiveSessionsCache("all_sessions", loader)).toEqual([]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["active_sessions", clearActiveSessionsCache],
    ["all_sessions", clearAllSessionsQueryCache],
    ["all_sessions", clearAllCaches],
  ] as const)("does not repopulate %s after invalidation", async (key, clear) => {
    const stale = deferredRows();
    const pending = getOrLoadActiveSessionsCache(key, () => stale.promise);
    clear();
    stale.resolve([]);
    await pending;
    expect(getActiveSessionsCache(key)).toBeNull();
  });

  it("does not replace or remove a newer in-flight query when an invalidated load completes", async () => {
    const stale = deferredRows();
    const fresh = deferredRows();
    const oldLoad = getOrLoadActiveSessionsCache("all_sessions", () => stale.promise);
    clearAllSessionsQueryCache();
    const newLoad = getOrLoadActiveSessionsCache("all_sessions", () => fresh.promise);
    stale.resolve([]);
    await oldLoad;
    expect(getActiveSessionsCache("all_sessions")).toBeNull();
    expect(getOrLoadActiveSessionsCache("all_sessions", async () => [])).toBe(newLoad);
    const rows: SessionRows = [];
    fresh.resolve(rows);
    await newLoad;
    expect(getActiveSessionsCache("all_sessions")).toBe(rows);
  });

  it("preserves a newer explicit cache write", async () => {
    const stale = deferredRows();
    const pending = getOrLoadActiveSessionsCache("all_sessions", () => stale.promise);
    const rows: SessionRows = [];
    setActiveSessionsCache(rows, "all_sessions");
    stale.resolve([]);
    await pending;
    expect(getActiveSessionsCache("all_sessions")).toBe(rows);
  });

  it("loads active and all-session inventories independently", async () => {
    const loader = vi.fn(async () => []);
    await Promise.all([
      getOrLoadActiveSessionsCache("active_sessions", loader),
      getOrLoadActiveSessionsCache("all_sessions", loader),
    ]);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
