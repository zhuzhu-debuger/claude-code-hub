"use strict";

function sample(forcedGc = false) {
  process.stdout.write(
    `${JSON.stringify({
      cchMemoryProbe: true,
      ts: Date.now(),
      forcedGc,
      ...process.memoryUsage(),
      activeTasks: globalThis.__ASYNC_TASK_MANAGER__?.getActiveTaskCount() ?? 0,
      requestMemory: globalThis[Symbol.for("cch.requestMemoryStats")]?.() ?? null,
      memoryLeases: globalThis[Symbol.for("cch.memoryGovernor")]?.snapshot().leases ?? null,
    })}\n`
  );
}

const timer = setInterval(sample, 1000);
timer.unref();
process.on("SIGUSR2", () => {
  global.gc?.();
  global.gc?.();
  sample(true);
});
sample();
