import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SessionTracker } from "@/lib/session-tracker";

const getSessionMock = vi.fn();
const getObservedActiveSessionsMock = vi.fn();
const getObservedConcurrentCountBatchMock = vi.fn();
const getAllSessionIdsMock = vi.fn();
const aggregateMultipleSessionStatsMock = vi.fn();

vi.mock("@/lib/auth", () => ({ getSession: getSessionMock }));
vi.mock("@/lib/logger", () => ({
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("@/lib/session-manager", () => ({
  SessionManager: {
    getAllSessionIds: getAllSessionIdsMock,
  },
}));
vi.mock("@/repository/message", () => ({
  aggregateMultipleSessionStats: aggregateMultipleSessionStatsMock,
}));

const SESSION_STATS = {
  sessionId: "pfx:scope:fingerprint",
  sessionIdentityKind: "prefix_affinity" as const,
  sessionFingerprint: "fingerprint",
  requestCount: 2,
  totalCostUsd: "0.01",
  totalInputTokens: 10,
  totalOutputTokens: 5,
  totalCacheCreationTokens: 0,
  totalCacheReadTokens: 0,
  totalDurationMs: 100,
  firstRequestAt: new Date("2026-08-02T00:00:00.000Z"),
  lastRequestAt: new Date("2026-08-02T00:01:00.000Z"),
  providers: [],
  models: ["model"],
  userName: "user",
  userId: 1,
  keyName: "key",
  keyId: 1,
  userAgent: "client",
  apiType: "chat",
  cacheTtlApplied: null,
};

const NOW = new Date("2026-08-02T00:02:00.000Z");

describe("getAllSessions monitoring status", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue({ user: { id: 1, role: "admin" } });
    const { clearAllCaches } = await import("@/lib/cache/session-cache");
    clearAllCaches();
    vi.spyOn(SessionTracker, "getObservedActiveSessions").mockImplementation(
      getObservedActiveSessionsMock
    );
    vi.spyOn(SessionTracker, "getObservedConcurrentCountBatch").mockImplementation(
      getObservedConcurrentCountBatchMock
    );
    getObservedActiveSessionsMock.mockResolvedValue([SESSION_STATS.sessionId]);
    getAllSessionIdsMock.mockResolvedValue([]);
    aggregateMultipleSessionStatsMock.mockResolvedValue([SESSION_STATS]);
    getObservedConcurrentCountBatchMock.mockResolvedValue(new Map([[SESSION_STATS.sessionId, 1]]));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("marks an observed prefix session as in progress", async () => {
    const { getAllSessions } = await import("@/actions/active-sessions");

    const result = await getAllSessions(1, 1, 20);

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          active: [
            expect.objectContaining({
              sessionId: SESSION_STATS.sessionId,
              status: "in_progress",
              concurrentCount: 1,
            }),
          ],
          totalActive: 1,
        }),
      })
    );
    expect(getObservedConcurrentCountBatchMock).toHaveBeenCalledWith([SESSION_STATS.sessionId]);
  });

  test("keeps an in-progress session active when its last request is older than five minutes", async () => {
    aggregateMultipleSessionStatsMock.mockResolvedValue([
      {
        ...SESSION_STATS,
        lastRequestAt: new Date("2026-08-01T23:00:00.000Z"),
      },
    ]);

    const { getAllSessions } = await import("@/actions/active-sessions");
    const result = await getAllSessions(1, 1, 20);

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          active: [
            expect.objectContaining({
              sessionId: SESSION_STATS.sessionId,
              status: "in_progress",
              concurrentCount: 1,
            }),
          ],
          inactive: [],
          totalActive: 1,
          totalInactive: 0,
        }),
      })
    );
  });

  test("keeps a cached in-progress session in the active page", async () => {
    const { setActiveSessionsCache } = await import("@/lib/cache/session-cache");
    setActiveSessionsCache(
      [
        {
          ...SESSION_STATS,
          lastRequestAt: new Date("2026-08-01T23:00:00.000Z"),
        },
      ],
      "all_sessions"
    );

    const { getAllSessions } = await import("@/actions/active-sessions");
    const result = await getAllSessions(1, 1, 20);

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          active: [expect.objectContaining({ status: "in_progress", concurrentCount: 1 })],
          inactive: [],
        }),
      })
    );
    expect(aggregateMultipleSessionStatsMock).not.toHaveBeenCalled();
  });

  test("coalesces simultaneous monitoring queries without sharing caller permissions", async () => {
    let finish!: (value: (typeof SESSION_STATS)[]) => void;
    const query = new Promise<(typeof SESSION_STATS)[]>((resolve) => {
      finish = resolve;
    });
    aggregateMultipleSessionStatsMock.mockReturnValue(query);
    const other = { ...SESSION_STATS, sessionId: "other-session", userId: 2 };
    getSessionMock
      .mockResolvedValueOnce({ user: { id: 1, role: "admin" } })
      .mockResolvedValueOnce({ user: { id: 2, role: "user" } });
    const { getAllSessions } = await import("@/actions/active-sessions");
    const admin = getAllSessions();
    const user = getAllSessions();
    finish([SESSION_STATS, other]);
    const [adminResult, userResult] = await Promise.all([admin, user]);

    expect(getAllSessionIdsMock).toHaveBeenCalledTimes(1);
    expect(getObservedActiveSessionsMock).toHaveBeenCalledTimes(1);
    expect(aggregateMultipleSessionStatsMock).toHaveBeenCalledTimes(1);
    expect(adminResult.ok && adminResult.data.totalActive).toBe(2);
    expect(userResult.ok && userResult.data.active.map((session) => session.userId)).toEqual([2]);
    expect(getObservedConcurrentCountBatchMock).toHaveBeenCalledWith([other.sessionId]);
  });

  test("retries after a shared aggregate fails", async () => {
    aggregateMultipleSessionStatsMock.mockRejectedValueOnce(new Error("database unavailable"));
    const { getAllSessions } = await import("@/actions/active-sessions");
    const failed = await Promise.all([getAllSessions(), getAllSessions()]);
    expect(failed.every((result) => !result.ok)).toBe(true);
    expect(aggregateMultipleSessionStatsMock).toHaveBeenCalledTimes(1);
    expect((await getAllSessions()).ok).toBe(true);
    expect(aggregateMultipleSessionStatsMock).toHaveBeenCalledTimes(2);
  });

  test("paginates active and inactive sessions before constructing their detail objects", async () => {
    const sessions = Array.from({ length: 100 }, (_, index) => ({
      ...SESSION_STATS,
      sessionId: `session-${index}`,
      lastRequestAt: index % 2 === 0 ? NOW : new Date(0),
    }));
    const readProviders = vi.fn(() => []);
    for (const session of sessions) {
      Object.defineProperty(session, "providers", { get: readProviders });
    }
    aggregateMultipleSessionStatsMock.mockResolvedValue(sessions);
    getObservedConcurrentCountBatchMock.mockResolvedValue(new Map());
    const { getAllSessions } = await import("@/actions/active-sessions");
    const result = await getAllSessions(2, 3, 5);

    expect(result.ok && result.data).toMatchObject({
      totalActive: 50,
      totalInactive: 50,
      hasMoreActive: true,
      hasMoreInactive: true,
    });
    expect(result.ok && result.data.active.map((session) => session.sessionId)).toEqual([
      "session-10",
      "session-12",
      "session-14",
      "session-16",
      "session-18",
    ]);
    expect(result.ok && result.data.inactive.map((session) => session.sessionId)).toEqual([
      "session-21",
      "session-23",
      "session-25",
      "session-27",
      "session-29",
    ]);
    expect(readProviders).toHaveBeenCalledTimes(20);
  });

  test("refreshes concurrency on cache hits without repeating the aggregate", async () => {
    const { getAllSessions } = await import("@/actions/active-sessions");
    const first = await getAllSessions();
    getObservedConcurrentCountBatchMock.mockResolvedValue(new Map());
    const second = await getAllSessions();
    expect(first.ok && first.data.active[0].status).toBe("in_progress");
    expect(second.ok && second.data.active[0].status).toBe("completed");
    expect(aggregateMultipleSessionStatsMock).toHaveBeenCalledTimes(1);
    expect(getObservedConcurrentCountBatchMock).toHaveBeenCalledTimes(2);
  });

  test("deduplicates observed and stored IDs, and refreshes after cache expiry", async () => {
    getAllSessionIdsMock.mockResolvedValue([SESSION_STATS.sessionId, "stored-session"]);
    const { getAllSessions } = await import("@/actions/active-sessions");
    await getAllSessions();
    expect(aggregateMultipleSessionStatsMock).toHaveBeenCalledWith([
      SESSION_STATS.sessionId,
      "stored-session",
    ]);
    vi.advanceTimersByTime(2001);
    await getAllSessions();
    expect(aggregateMultipleSessionStatsMock).toHaveBeenCalledTimes(2);
  });

  test("caches an empty inventory without querying the database", async () => {
    getObservedActiveSessionsMock.mockResolvedValue([]);
    const { getAllSessions } = await import("@/actions/active-sessions");
    const result = await getAllSessions();
    await getAllSessions();
    expect(result).toEqual({
      ok: true,
      data: {
        active: [],
        inactive: [],
        totalActive: 0,
        totalInactive: 0,
        hasMoreActive: false,
        hasMoreInactive: false,
      },
    });
    expect(aggregateMultipleSessionStatsMock).not.toHaveBeenCalled();
    expect(getObservedActiveSessionsMock).toHaveBeenCalledTimes(1);
    expect(getObservedConcurrentCountBatchMock).not.toHaveBeenCalled();
  });

  test("returns empty pages past the end without losing totals", async () => {
    const { getAllSessions } = await import("@/actions/active-sessions");
    const result = await getAllSessions(3, 3, 20);
    expect(result.ok && result.data).toMatchObject({
      active: [],
      inactive: [],
      totalActive: 1,
      hasMoreActive: false,
      hasMoreInactive: false,
    });
  });

  test("normalizes invalid pagination without changing the first page", async () => {
    const { getAllSessions } = await import("@/actions/active-sessions");
    const result = await getAllSessions(Number.NaN, Number.POSITIVE_INFINITY, Number.NaN);
    expect(result.ok && result.data.active).toHaveLength(1);
    const negative = await getAllSessions(-1, -1, -1);
    expect(negative.ok && negative.data.active).toHaveLength(1);
  });

  test("rejects unauthenticated monitoring requests before loading data", async () => {
    getSessionMock.mockResolvedValue(null);
    const { getAllSessions, getActiveSessions } = await import("@/actions/active-sessions");
    expect((await getAllSessions()).ok).toBe(false);
    expect((await getActiveSessions()).ok).toBe(false);
    expect(getObservedActiveSessionsMock).not.toHaveBeenCalled();
  });

  test("shares active inventory loads and filters ordinary users on each call", async () => {
    aggregateMultipleSessionStatsMock.mockResolvedValue([
      SESSION_STATS,
      { ...SESSION_STATS, sessionId: "other-session", userId: 2 },
    ]);
    getSessionMock.mockResolvedValue({ user: { id: 2, role: "user" } });
    const { getActiveSessions } = await import("@/actions/active-sessions");
    const results = await Promise.all([getActiveSessions(), getActiveSessions()]);
    expect(aggregateMultipleSessionStatsMock).toHaveBeenCalledTimes(1);
    expect(getAllSessionIdsMock).not.toHaveBeenCalled();
    expect(results[0].ok && results[0].data.map((session) => session.userId)).toEqual([2]);
    expect(getObservedConcurrentCountBatchMock).toHaveBeenCalledWith(["other-session"]);
  });

  test("handles empty and failed active inventory loads", async () => {
    getObservedActiveSessionsMock.mockRejectedValueOnce(new Error("redis unavailable"));
    const { getActiveSessions } = await import("@/actions/active-sessions");
    expect((await getActiveSessions()).ok).toBe(false);
    getObservedActiveSessionsMock.mockResolvedValue([]);
    expect(await getActiveSessions()).toEqual({ ok: true, data: [] });
  });
});
