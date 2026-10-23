import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { values } = parseArgs({
  options: {
    output: { type: "string" },
    concurrency: { type: "string", default: "32" },
    waves: { type: "string", default: "2" },
    cycles: { type: "string", default: "1" },
    "replay-detached-ms": { type: "string", default: "300000" },
    "payload-bytes": { type: "string", default: "1048576" },
  },
});
const concurrency = Number(values.concurrency);
const waves = Number(values.waves);
const cycles = Number(values.cycles);
const replayDetachedMs = Number(values["replay-detached-ms"]);
const payloadBytes = Number(values["payload-bytes"]);
assert(Number.isSafeInteger(concurrency) && concurrency > 0 && concurrency <= 64);
assert(Number.isSafeInteger(waves) && waves > 0 && waves <= 10);
assert(Number.isSafeInteger(cycles) && cycles > 0 && cycles <= 10);
assert(
  Number.isSafeInteger(replayDetachedMs) && replayDetachedMs >= 10000 && replayDetachedMs <= 300000
);
assert(Number.isSafeInteger(payloadBytes) && payloadBytes >= 65536 && payloadBytes <= 5 * 1048576);
const output = values.output
  ? path.resolve(values.output)
  : mkdtempSync(path.join(tmpdir(), "cch-memory-"));
mkdirSync(output, { recursive: true });
const standalone = path.join(root, ".next/standalone");
assert(existsSync(path.join(standalone, "server.js")), "Run bun run build first");
const runId = `cch-memory-${randomBytes(5).toString("hex")}`;
const containers = [];
let app;
let mock;
const samples = [];
const metrics = [];
const lifecycle = [];
const recoveries = [];
const dbPassword = randomBytes(24).toString("hex");
const adminToken = randomBytes(24).toString("hex");
const sockets = new Set();
const require = createRequire(import.meta.url);
const { buildSseFrames } = require("../issue-1408-replay-oom/mock-upstream.cjs");
const completedFrames = buildSseFrames(payloadBytes, "complete");
const hangingFrames = buildSseFrames(payloadBytes, "disconnect");
const expectedHash = createHash("sha256").update(completedFrames.join("")).digest("hex");
let mockReceived = 0;
let mockActive = 0;
const stage = (name) => {
  lifecycle.push({ name, ts: Date.now() });
  console.log(JSON.stringify({ stage: name, output }));
};
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let cleanupPromise;
function cleanup() {
  cleanupPromise ??= (async () => {
    writeFileSync(
      path.join(output, "samples.jsonl"),
      samples.map((sample) => JSON.stringify(sample)).join("\n")
    );
    if (app && app.exitCode === null) {
      app.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => app.once("exit", resolve)), delay(10000)]);
      if (app.exitCode === null) app.kill("SIGKILL");
    }
    for (const socket of sockets) socket.destroy();
    mock?.close();
    for (const container of containers.reverse()) docker("rm", "-f", container);
  })();
  return cleanupPromise;
}
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(code));
  });
}

function startContainer(kind, image, port, extra) {
  const name = `${runId}-${kind}`;
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--label",
    "cch.memory-fixture=true",
    "--memory=512m",
    "-p",
    `127.0.0.1::${port}`,
    ...extra,
    image,
    ...(kind === "redis" ? ["redis-server", "--save", "", "--appendonly", "no"] : [])
  );
  containers.push(name);
  const published = docker("port", name, `${port}/tcp`);
  return { name, port: Number(published.split(":").at(-1)) };
}
async function waitFor(check, timeout = 90000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (app?.exitCode !== null && app?.exitCode !== undefined)
      throw new Error("App exited; inspect app.log");
    try {
      if (await check()) return;
    } catch {}
    await delay(500);
  }
  throw new Error("Timed out waiting for isolated fixture readiness/cleanup");
}
async function collectAfterGc() {
  const offset = samples.length;
  app.kill("SIGUSR2");
  await waitFor(() => samples.slice(offset).some((sample) => sample.forcedGc), 5000);
  return samples.slice(offset).find((sample) => sample.forcedGc);
}
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}
async function api(base, endpoint, body, method = "POST") {
  const response = await fetch(`${base}${endpoint}`, {
    method,
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  assert(response.ok, `Fixture setup ${endpoint}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}
function request(base, key, mode, index) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let firstByteMs = null;
    let bytes = 0;
    let timer;
    let settled = false;
    const digest = createHash("sha256");
    const body = JSON.stringify({
      model: "gpt-5.6",
      stream: true,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: `CCH_SCENARIO_${mode} ${runId} ${index}` }],
        },
      ],
      prompt_cache_key: `${runId}-${mode}-${index}`,
    });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ mode, index, bytes, firstByteMs, durationMs: performance.now() - started });
    };
    const req = http.request(
      `${base}/v1/responses`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          session_id: randomUUID(),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let errorBody = "";
          res.on("data", (chunk) => {
            if (errorBody.length < 1000) errorBody += chunk.toString();
          });
          res.once("end", () =>
            finish(new Error(`Proxy returned ${res.statusCode}: ${errorBody}`))
          );
          return;
        }
        res.on("data", (chunk) => {
          if (firstByteMs === null) {
            firstByteMs = performance.now() - started;
            if (mode === "cancel")
              timer = setTimeout(() => {
                res.destroy();
                req.destroy();
                finish();
              }, 250);
          }
          bytes += chunk.length;
          digest.update(chunk);
        });
        res.once("end", () => {
          if (mode === "complete") {
            try {
              assert.equal(bytes, payloadBytes, "Normal response byte count changed");
              assert.equal(digest.digest("hex"), expectedHash, "Normal response content changed");
            } catch (error) {
              finish(error);
              return;
            }
          }
          finish();
        });
        res.once("error", (error) => {
          if (!settled && mode !== "cancel") finish(error);
        });
      }
    );
    req.setTimeout(60000, () => req.destroy(new Error("Proxy request timeout")));
    req.once("error", (error) => {
      if (!settled) finish(error);
    });
    req.end(body);
  });
}
try {
  stage("starting-isolated-services");
  const pg = startContainer("pg", "postgres:17", 5432, [
    "-e",
    `POSTGRES_PASSWORD=${dbPassword}`,
    "-e",
    "POSTGRES_DB=cch_memory_test",
  ]);
  const redis = startContainer("redis", "redis:7-alpine", 6379, []);
  await waitFor(() =>
    docker("exec", pg.name, "pg_isready", "-U", "postgres").includes("accepting")
  );
  mock = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.method !== "POST" || !req.url.endsWith("/responses")) {
      res.writeHead(404).end();
      return;
    }
    mockReceived++;
    mockActive++;
    res.once("close", () => mockActive--);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const frames = body.includes("CCH_SCENARIO_cancel") ? hangingFrames : completedFrames;
    for (const frame of frames) {
      if (res.destroyed) return;
      if (!res.write(frame))
        await new Promise((resolve) => {
          const ready = () => {
            res.off("drain", ready);
            res.off("close", ready);
            resolve();
          };
          res.once("drain", ready);
          res.once("close", ready);
        });
    }
    if (frames === completedFrames) res.end();
  });
  mock.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const mockPort = await listen(mock);
  const reservation = http.createServer();
  const appPort = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const base = `http://127.0.0.1:${appPort}`;
  const appEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    NODE_ENV: "production",
    HOSTNAME: "127.0.0.1",
    PORT: String(appPort),
    ADMIN_TOKEN: adminToken,
    DSN: `postgres://postgres:${dbPassword}@127.0.0.1:${pg.port}/cch_memory_test`,
    REDIS_URL: `redis://127.0.0.1:${redis.port}`,
    API_BASE_URL: base,
    AUTO_MIGRATE: "true",
    ENABLE_RATE_LIMIT: "true",
    LOG_LEVEL: "info",
    ENABLE_REQUEST_REPLAY: "true",
    REPLAY_MAX_DETACHED_MS: String(replayDetachedMs),
    STORE_SESSION_RESPONSE_BODY: "true",
    SESSION_RESPONSE_BODY_DEDUP_ENABLED: "true",
    STREAM_GATE_MODE: "enforce",
    CCH_MEMORY_BUDGET_BYTES: "1073741824",
    CCH_MULTICORE_ACTIVE: "0",
    CCH_MULTICORE_BACKGROUND_OWNER: "0",
  };
  stage("migrating-test-database");
  const migrationLog = execFileSync("bun", ["--conditions=react-server", "scripts/migrate.ts"], {
    cwd: root,
    env: appEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 90000,
  });
  writeFileSync(path.join(output, "migration.log"), migrationLog);
  const log = createWriteStream(path.join(output, "app.log"));
  app = spawn(
    process.execPath,
    [
      "--expose-gc",
      "--max-old-space-size=1024",
      "--require",
      path.join(root, "tests/load/memory-regression/live-memory-probe.cjs"),
      "server.js",
    ],
    { cwd: standalone, env: appEnv, stdio: ["ignore", "pipe", "pipe"] }
  );
  app.stdout.pipe(log);
  app.stderr.pipe(log, { end: false });
  let buffered = "";
  app.stdout.on("data", (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split("\n");
    buffered = lines.pop();
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item.cchMemoryProbe) samples.push(item);
      } catch {}
    }
  });
  await waitFor(
    async () => (await fetch(`${base}/api/health/ready`, { signal: AbortSignal.timeout(2000) })).ok
  );
  stage("creating-test-provider-and-key");
  await api(
    base,
    "/api/v1/model-prices/gpt-5.6",
    {
      modelName: "gpt-5.6",
      mode: "chat",
      litellmProvider: "openai",
      inputCostPerToken: 0.000001,
      outputCostPerToken: 0.000002,
    },
    "PUT"
  );
  await api(base, "/api/v1/providers", {
    name: runId,
    url: `http://127.0.0.1:${mockPort}`,
    key: "isolated-mock-only",
    provider_type: "codex",
    is_enabled: true,
    streaming_idle_timeout_ms: 600000,
  });
  const user = await api(base, "/api/v1/users", {
    name: runId,
    rpm: 0,
    dailyQuota: 0,
    limitConcurrentSessions: 0,
  });
  const key = user.defaultKey.key;
  const userId = user.user.id;
  await request(base, key, "complete", "warmup");
  await waitFor(
    () =>
      mockActive === 0 &&
      samples.at(-1)?.activeTasks === 0 &&
      (samples.at(-1)?.requestMemory?.active ?? 0) === 0
  );
  await delay(1000);
  const baseline = await collectAfterGc();
  stage("baseline");
  for (let cycle = 0; cycle < cycles; cycle++) {
    for (const mode of ["complete", "cancel"]) {
      stage(`${mode}-${cycle}`);
      for (let wave = 0; wave < waves; wave++) {
        metrics.push(
          ...(await Promise.all(
            Array.from({ length: concurrency }, (_, index) =>
              request(base, key, mode, `${cycle}-${wave}-${index}`)
            )
          ))
        );
        await delay(500);
      }
      stage(`${mode}-${cycle}-quiet`);
      await waitFor(
        () =>
          mockActive === 0 &&
          samples.at(-1)?.activeTasks === 0 &&
          (samples.at(-1)?.requestMemory?.active ?? 0) === 0,
        Math.max(90000, replayDetachedMs + 60000)
      );
      await delay(2000);
      recoveries.push({ cycle, mode, sample: await collectAfterGc() });
    }
  }
  const ledger = JSON.parse(
    docker(
      "exec",
      pg.name,
      "psql",
      "-U",
      "postgres",
      "-d",
      "cch_memory_test",
      "-At",
      "-c",
      `SELECT json_build_object('rows',count(*),'completed',count(*) FILTER (WHERE status_code=200),'inputTokens',coalesce(sum(input_tokens),0),'outputTokens',coalesce(sum(output_tokens),0),'costUsd',coalesce(sum(cost_usd),0)) FROM usage_ledger WHERE user_id=${userId}`
    )
  );
  const expectedCompleted = concurrency * waves * cycles + 1;
  const expectedCanceled = concurrency * waves * cycles;
  const statusCounts = JSON.parse(
    docker(
      "exec",
      pg.name,
      "psql",
      "-U",
      "postgres",
      "-d",
      "cch_memory_test",
      "-At",
      "-c",
      `SELECT coalesce(json_object_agg(coalesce(status_code::text,'null'),n),'{}') FROM (SELECT status_code,count(*) n FROM usage_ledger WHERE user_id=${userId} GROUP BY status_code) counts`
    )
  );
  assert.equal(
    ledger.rows,
    expectedCompleted + expectedCanceled,
    "Missing or duplicate ledger rows"
  );
  assert.equal(ledger.completed, expectedCompleted, "Completed request terminal statuses differ");
  assert.equal(
    statusCounts["499"],
    expectedCanceled,
    "Canceled requests must finalize as client-aborted"
  );
  assert(
    ledger.inputTokens === expectedCompleted && ledger.outputTokens === expectedCompleted,
    "Usage tokens were lost"
  );
  assert(
    Math.abs(Number(ledger.costUsd) - expectedCompleted * 0.000003) < 1e-9,
    "Completed request billing differs from fixture prices"
  );
  assert.equal(mockReceived, expectedCompleted + expectedCanceled, "Unexpected upstream retries");
  const redisMemory = docker("exec", redis.name, "redis-cli", "INFO", "memory");
  const redisFinal = {
    usedMemoryBytes: Number(redisMemory.match(/^used_memory:(\d+)/m)?.[1]),
    usedMemoryPeakBytes: Number(redisMemory.match(/^used_memory_peak:(\d+)/m)?.[1]),
    keyCount: Number(docker("exec", redis.name, "redis-cli", "DBSIZE")),
  };
  const normalFirstByte = metrics
    .filter((entry) => entry.mode === "complete")
    .map((entry) => entry.firstByteMs)
    .sort((a, b) => a - b);
  const middle = Math.floor(normalFirstByte.length / 2);
  const firstByteMs = {
    median:
      normalFirstByte.length % 2
        ? normalFirstByte[middle]
        : (normalFirstByte[middle - 1] + normalFirstByte[middle]) / 2,
    p95: normalFirstByte[Math.ceil(normalFirstByte.length * 0.95) - 1],
    p95Method: "nearest-rank",
  };
  const final = recoveries.at(-1).sample;
  assert.equal(final.activeTasks, 0);
  assert.equal(final.requestMemory?.active ?? 0, 0);
  const summary = {
    runId,
    revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    node: process.version,
    concurrency,
    waves,
    cycles,
    payloadBytes,
    configuration: {
      replay: true,
      replayMaxDetachedMs: replayDetachedMs,
      providerStreamingIdleTimeoutMs: 600000,
      responseDedup: true,
      streamGateMode: "enforce",
      memoryAdmissionEnabled: false,
      memoryBudgetBytes: 1073741824,
    },
    normalResponsesVerified: metrics.filter((entry) => entry.mode === "complete").length,
    canceledClients: metrics.filter((entry) => entry.mode === "cancel").length,
    mockReceived,
    baseline,
    final,
    peaks: Object.fromEntries(
      ["rss", "heapUsed", "external", "arrayBuffers", "activeTasks"].map((name) => [
        name,
        Math.max(...samples.map((sample) => sample[name])),
      ])
    ),
    ledger,
    statusCounts,
    redisFinal,
    firstByteMs,
    recoveries,
    lifecycle,
    metrics,
  };
  writeFileSync(path.join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    JSON.stringify({
      stage: "passed",
      output,
      summary: { ...summary, metrics: undefined, lifecycle: undefined },
    })
  );
} finally {
  await cleanup();
}
