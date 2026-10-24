import { AsyncLocalStorage } from "node:async_hooks";
import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";
import type { MemoryLease } from "./governor";

const DEFAULT_BACKGROUND_GRACE_MS = 150_000;
const LOSER_DRAIN_MARGIN_MS = 30_000;

interface LifetimeStatsState {
  active: number;
  forcedTotal: number;
  draining: Set<RequestMemoryLifetime>;
}

export interface RequestMemoryLifetimeStats {
  active: number;
  draining: number;
  oldestDrainingAgeMs: number;
  forcedTotal: number;
  drainingLabels: Record<string, number>;
}

function resolveBackgroundGraceMs(): number {
  try {
    const env = getEnvConfig();
    return Math.max(
      env.REQUEST_MEMORY_BACKGROUND_GRACE_MS,
      env.HEDGE_LOSER_DRAIN_TIMEOUT_MS + LOSER_DRAIN_MARGIN_MS
    );
  } catch {
    return DEFAULT_BACKGROUND_GRACE_MS;
  }
}

/**
 * 响应与后台消费者共同拥有请求分配；取消不等同于消费者已退出。
 * 响应结束后后台所有者只有有限宽限：永不 settle 的 Promise 不能永久占用正文额度。
 */
class RequestMemoryLifetime {
  private owners = 1;
  private leases = new Set<MemoryLease>();
  private retainers = new Map<object, string>();
  private disposers: Array<() => void> = [];
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private drainingSince: number | null = null;
  private lastActivityAt = 0;

  constructor() {
    stats.active++;
  }

  add(lease: MemoryLease): boolean {
    if (this.owners === 0) return false;
    this.leases.add(lease);
    return true;
  }

  onForcedEnd(dispose: () => void): void {
    if (this.owners !== 0) this.disposers.push(dispose);
  }

  retain(label = "unlabeled"): RequestMemoryRetention {
    if (this.owners === 0) return noopRetention;
    this.owners++;
    const token = {};
    this.retainers.set(token, label);
    const release = () => {
      if (!this.retainers.delete(token)) return;
      this.release();
    };
    // 仍在推进的后台消费者（例如客户端断线后的上游引流）刷新宽限；只有停滞的所有者才会被强制结束。
    release.touch = () => {
      if (this.retainers.has(token)) this.lastActivityAt = Date.now();
    };
    return release;
  }

  /** 根所有者（响应）结束；仍有后台所有者时开始计宽限。 */
  releaseRoot(): void {
    if (this.owners > 1 && this.drainingSince === null) {
      this.drainingSince = Date.now();
      this.lastActivityAt = this.drainingSince;
      stats.draining.add(this);
      this.armGraceTimer(resolveBackgroundGraceMs());
    }
    this.release();
  }

  private armGraceTimer(delayMs: number): void {
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (this.owners === 0) return;
      const graceMs = resolveBackgroundGraceMs();
      const idleMs = Date.now() - this.lastActivityAt;
      if (idleMs < graceMs) this.armGraceTimer(graceMs - idleMs);
      else this.forceEnd();
    }, delayMs);
    this.graceTimer.unref?.();
  }

  drainingAgeMs(now: number): number {
    return this.drainingSince === null ? 0 : now - this.drainingSince;
  }

  retainerLabels(): string[] {
    return Array.from(this.retainers.values());
  }

  private release(): void {
    if (this.owners === 0 || --this.owners !== 0) return;
    this.finish();
  }

  private finish(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    stats.draining.delete(this);
    stats.active--;
    for (const lease of this.leases) lease.release();
    this.leases.clear();
    this.retainers.clear();
    this.disposers = [];
  }

  private forceEnd(): void {
    if (this.owners === 0) return;
    let reservedBytes = 0;
    for (const lease of this.leases) reservedBytes += lease.reservedBytes;
    logger.warn("[RequestMemory] Background owners exceeded grace; force releasing leases", {
      stuckOwners: this.retainerLabels(),
      drainingAgeMs: this.drainingAgeMs(Date.now()),
      leases: this.leases.size,
      reservedBytes,
    });
    const disposers = this.disposers;
    this.owners = 0;
    stats.forcedTotal++;
    this.finish();
    for (const dispose of disposers) {
      try {
        dispose();
      } catch (error) {
        logger.warn("[RequestMemory] Forced-end disposer failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

export type RequestMemoryRetention = (() => void) & { touch(): void };
const noopRetention: RequestMemoryRetention = Object.assign(() => {}, { touch: () => {} });

const storageKey = Symbol.for("cch.requestMemoryLifetime");
const statsStateKey = Symbol.for("cch.requestMemoryStatsState");
const statsKey = Symbol.for("cch.requestMemoryStats");
const globals = globalThis as typeof globalThis & {
  [storageKey]?: AsyncLocalStorage<RequestMemoryLifetime>;
  [statsStateKey]?: LifetimeStatsState;
  [statsKey]?: () => RequestMemoryLifetimeStats;
};
const storage = (globals[storageKey] ??= new AsyncLocalStorage<RequestMemoryLifetime>());
const stats = (globals[statsStateKey] ??= { active: 0, forcedTotal: 0, draining: new Set() });
const abandonedResponses = new FinalizationRegistry<() => void>((release) => release());

/** 供 server.js 的 worker_memory_stats 读取：响应已结束但仍被后台所有者占用的请求。 */
export function getRequestMemoryLifetimeStats(): RequestMemoryLifetimeStats {
  const now = Date.now();
  let oldestDrainingAgeMs = 0;
  const drainingLabels: Record<string, number> = {};
  for (const lifetime of stats.draining) {
    oldestDrainingAgeMs = Math.max(oldestDrainingAgeMs, lifetime.drainingAgeMs(now));
    for (const label of lifetime.retainerLabels()) {
      drainingLabels[label] = (drainingLabels[label] ?? 0) + 1;
    }
  }
  return {
    active: stats.active,
    draining: stats.draining.size,
    oldestDrainingAgeMs,
    forcedTotal: stats.forcedTotal,
    drainingLabels,
  };
}
globals[statsKey] = getRequestMemoryLifetimeStats;

/** 返回 false 的独立调用方（或作用域已结束）仍可使用 GC 兜底；HTTP 入口总有明确所有者。 */
export function attachRequestMemory(lease: MemoryLease): boolean {
  return storage.getStore()?.add(lease) ?? false;
}

/** 宽限到期被强制结束时调用，用于丢弃仍被卡住的消费者引用的正文缓冲。 */
export function onRequestMemoryForcedEnd(dispose: () => void): void {
  storage.getStore()?.onForcedEnd(dispose);
}

/** 在后台任务实际结束时调用；不能在只发出 abort 时归还。label 用于定位卡住的所有者。 */
export function retainCurrentRequestMemory(label?: string): RequestMemoryRetention {
  return storage.getStore()?.retain(label) ?? noopRetention;
}

export function retainRequestMemoryUntil<T>(promise: Promise<T>, label?: string): Promise<T> {
  return promise.finally(retainCurrentRequestMemory(label));
}

/** EOF、读错、取消和无正文响应均确定性释放根所有者，无需触发 V8 GC。 */
function responseOwner(lifetime: RequestMemoryLifetime) {
  const token = {};
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    abandonedResponses.unregister(token);
    lifetime.releaseRoot();
  };
  return { token, release };
}

export async function withRequestMemoryLifetime(
  operation: () => Promise<Response>,
  clientAbortSignal?: AbortSignal | null
): Promise<Response> {
  const lifetime = new RequestMemoryLifetime();
  const { token, release: releaseRoot } = responseOwner(lifetime);
  return storage.run(lifetime, async () => {
    // Disconnect can precede the returned Response. Keep the operation's body
    // ownership until it settles, independently of the downstream connection.
    const releaseOperation = lifetime.retain("request-operation");
    let responseReleased = false;
    let cancelResponse: ((reason: unknown) => Promise<void>) | null = null;
    const release = () => {
      if (responseReleased) return;
      responseReleased = true;
      clientAbortSignal?.removeEventListener("abort", onClientAbort);
      releaseRoot();
    };
    const onClientAbort = () => {
      if (cancelResponse) {
        // Cancellation belongs to the response source; downstream disconnection
        // must not wait for its promise (for example, an unfinished tee branch).
        void cancelResponse(clientAbortSignal?.reason).catch(() => {});
      } else {
        release();
      }
    };
    if (clientAbortSignal?.aborted) onClientAbort();
    else clientAbortSignal?.addEventListener("abort", onClientAbort, { once: true });

    try {
      const response = await operation();
      if (!response.body) {
        release();
        return response;
      }
      const reader = response.body.getReader();
      let ended = false;
      // The incoming signal may outlive the Response. Its abort listener must
      // not keep the wrapper body alive through a strong controller reference.
      let clientController: WeakRef<ReadableStreamDefaultController<Uint8Array>>;
      const cancelReader = (reason: unknown): Promise<void> => {
        if (ended) return Promise.resolve();
        ended = true;
        const releaseCancellation = lifetime.retain("response-cancel");
        try {
          return reader.cancel(reason).finally(releaseCancellation);
        } catch (error) {
          releaseCancellation();
          return Promise.reject(error);
        } finally {
          reader.releaseLock();
          // A stuck cancel remains a background owner, so existing grace and
          // body disposal still apply without leaving the response root active.
          release();
        }
      };
      const wrapped = new Response(
        new ReadableStream<Uint8Array>(
          {
            start(streamController) {
              clientController = new WeakRef(streamController);
            },
            pull(controller) {
              return storage.run(lifetime, async () => {
                try {
                  const result = await reader.read();
                  if (ended) return;
                  if (result.done) {
                    ended = true;
                    reader.releaseLock();
                    release();
                    controller.close();
                  } else controller.enqueue(result.value);
                } catch (error) {
                  if (ended) return;
                  ended = true;
                  reader.releaseLock();
                  release();
                  controller.error(error);
                }
              });
            },
            cancel(reason) {
              return storage.run(lifetime, () => cancelReader(reason));
            },
          },
          { highWaterMark: 0 }
        ),
        { status: response.status, statusText: response.statusText, headers: response.headers }
      );
      cancelResponse = (reason) => {
        if (!ended) clientController.deref()?.error(reason);
        return storage.run(lifetime, () => cancelReader(reason));
      };
      // The framework may discard a response returned after the socket closed,
      // so neither pull nor cancel on its body is guaranteed to run.
      if (clientAbortSignal?.aborted) onClientAbort();
      // 框架可能仅转交 body 并重建 Response；GC 兜底必须跟随仍被读取的流。
      // Abandonment also cancels the source and removes the signal listener.
      if (!responseReleased) abandonedResponses.register(wrapped.body!, onClientAbort, token);
      return wrapped;
    } catch (error) {
      release();
      throw error;
    } finally {
      releaseOperation();
    }
  });
}
