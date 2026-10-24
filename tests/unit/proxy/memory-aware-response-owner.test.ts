// @vitest-environment node
import { Context } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import { getRequestMemoryLifetimeStats } from "@/lib/memory/request-lifetime";
import { MemoryGovernor } from "../../../server-lib/memory-governor";

const boundary = vi.hoisted(() => ({
  runGuards: vi.fn<(session: ProxySession) => Promise<Response | null>>(),
  settings: { enableMemoryAdmission: false },
}));

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  getCachedSystemSettings: async () => boundary.settings,
  getCachedSystemSettingsOnlyCache: () => boundary.settings,
}));

vi.mock("@/app/v1/_lib/proxy/guard-pipeline", () => ({
  GuardPipelineBuilder: { fromSession: () => ({ run: boundary.runGuards }) },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  },
}));

import { handleProxyRequest } from "@/app/v1/_lib/proxy-handler";

const governorKey = Symbol.for("cch.memoryGovernor");
const globals = globalThis as unknown as Record<symbol, unknown>;
let previousGovernor: unknown;
let governor: MemoryGovernor;

function createContext(signal: AbortSignal): Context {
  return new Context(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-test",
        messages: [{ role: "user", content: "x".repeat(1024 * 1024) }],
      }),
    })
  );
}

beforeEach(() => {
  previousGovernor = globals[governorKey];
  governor = new MemoryGovernor({
    limit: 128 * 1024 ** 2,
    remote: false,
    monitor: false,
    enabled: false,
  });
  globals[governorKey] = governor;
  boundary.runGuards.mockReset();
});

afterEach(() => {
  globals[governorKey] = previousGovernor;
});

describe("proxy request memory after downstream disconnect", () => {
  it("releases a large body when the client disconnects before a guard returns an unread response", async () => {
    const initialActive = getRequestMemoryLifetimeStats().active;
    const entered = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<Response>();
    const client = new AbortController();
    boundary.runGuards.mockImplementation(async (session) => {
      expect(session.request.message.messages).toHaveLength(1);
      entered.resolve();
      return ready.promise;
    });
    const pending = handleProxyRequest(createContext(client.signal));
    await entered.promise;
    expect(governor.snapshot().leases.byTag.body_materialize.bytes).toBeGreaterThan(4 * 1024 ** 2);

    client.abort(new Error("client disconnected before response headers"));
    // The handler is still using the parsed request, so abort cannot free it early.
    expect(getRequestMemoryLifetimeStats().active).toBe(initialActive + 1);
    expect(governor.snapshot().leases.count).toBeGreaterThan(0);
    ready.resolve(new Response("request rejected", { status: 403 }));
    const abandoned = await pending;
    try {
      // A disconnected HTTP adapter never consumes this response body.
      await vi.waitFor(() => {
        expect(getRequestMemoryLifetimeStats().active).toBe(initialActive);
        expect(governor.snapshot().leases.count).toBe(0);
      });
    } finally {
      await abandoned.body?.cancel().catch(() => {});
    }
  });

  it("reclaims repeated unconsumed responses after the inbound signal aborts without relying on GC", async () => {
    const initialActive = getRequestMemoryLifetimeStats().active;
    boundary.runGuards.mockImplementation(async () => new Response("ready", { status: 202 }));
    for (let wave = 0; wave < 3; wave++) {
      const clients = Array.from({ length: 8 }, () => new AbortController());
      const abandoned = await Promise.all(
        clients.map((client) => handleProxyRequest(createContext(client.signal)))
      );
      expect(getRequestMemoryLifetimeStats().active).toBe(initialActive + clients.length);
      expect(governor.snapshot().leases.count).toBe(clients.length);
      try {
        for (const client of clients) client.abort();
        await vi.waitFor(() => {
          expect(getRequestMemoryLifetimeStats().active).toBe(initialActive);
          expect(governor.snapshot().leases.count).toBe(0);
        });
      } finally {
        await Promise.all(abandoned.map((response) => response.body?.cancel().catch(() => {})));
      }
    }
  });

  it("preserves a connected response and releases its body once on EOF even if abort arrives later", async () => {
    const initialActive = getRequestMemoryLifetimeStats().active;
    const client = new AbortController();
    boundary.runGuards.mockImplementation(async () => new Response("unchanged", { status: 202 }));
    const response = await handleProxyRequest(createContext(client.signal));
    expect(response.status).toBe(202);
    expect(getRequestMemoryLifetimeStats().active).toBe(initialActive + 1);
    expect(governor.snapshot().leases.count).toBe(1);
    expect(await response.text()).toBe("unchanged");
    client.abort();
    expect(getRequestMemoryLifetimeStats().active).toBe(initialActive);
    expect(governor.snapshot().leases.count).toBe(0);
  });
});
