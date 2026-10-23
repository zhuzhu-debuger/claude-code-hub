import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { values } = parseArgs({
  options: {
    baseline: { type: "string", default: "HEAD" },
    streams: { type: "string", default: "32" },
    chunks: { type: "string", default: "64" },
    "chunk-bytes": { type: "string", default: "65536" },
  },
});
const options = {
  streams: Number(values.streams),
  chunks: Number(values.chunks),
  chunkBytes: Number(values["chunk-bytes"]),
};
for (const [key, value] of Object.entries(options)) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be positive`);
}

const modulePath = "src/app/v1/_lib/proxy/response-fixer/sse-chunk-buffer.ts";
const legacyPath = "src/app/v1/_lib/proxy/response-fixer/index.ts";
const revision = execFileSync("git", ["rev-parse", values.baseline], {
  cwd: root,
  encoding: "utf8",
}).trim();

function baselineSource() {
  try {
    return execFileSync("git", ["show", `${revision}:${modulePath}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    const index = execFileSync("git", ["show", `${revision}:${legacyPath}`], {
      cwd: root,
      encoding: "utf8",
    });
    const start = index.indexOf("class ChunkBuffer {");
    const end = index.indexOf("\nfunction persistSpecialSettings", start);
    if (start < 0 || end < 0) throw new Error("Baseline SSE buffer was not found");
    return (
      "const LF_BYTE = 10; const CR_BYTE = 13;\n" +
      index.slice(start, end).replace("class ChunkBuffer", "export class SseChunkBuffer")
    );
  }
}

function measure(source) {
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`;
  const program = `
    import { SseChunkBuffer } from ${JSON.stringify(moduleUrl)};
    const options = ${JSON.stringify(options)};
    global.gc();
    const initial = process.memoryUsage();
    const live = [];
    function consume() {
      for (let stream = 0; stream < options.streams; stream++) {
        const buffer = new SseChunkBuffer();
        live.push(buffer);
        for (let index = 0; index < options.chunks; index++) {
          const chunk = new Uint8Array(options.chunkBytes).fill(65);
          chunk[chunk.length - 1] = 10;
          buffer.push(chunk);
          buffer.take(buffer.findProcessableEnd());
        }
      }
    }
    consume();
    global.gc(); global.gc();
    const final = process.memoryUsage();
    console.log(JSON.stringify({
      unreadBytes: live.reduce((sum, buffer) => sum + buffer.length, 0),
      retainedArrayBufferBytes: final.arrayBuffers - initial.arrayBuffers,
      heapUsedDeltaBytes: final.heapUsed - initial.heapUsed,
      rssDeltaBytes: final.rss - initial.rss,
    }));
  `;
  const child = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-"], {
    input: program,
    encoding: "utf8",
    timeout: 60000,
  });
  if (child.status !== 0) throw new Error(child.stderr || String(child.error));
  return JSON.parse(child.stdout);
}

const baseline = measure(baselineSource());
const working = measure(readFileSync(path.join(root, modulePath), "utf8"));
console.log(
  JSON.stringify(
    {
      scenario: "consumed SSE chunks retained by active responses",
      node: process.version,
      baselineRevision: revision,
      options,
      baseline,
      working,
      retainedBytesAvoided: baseline.retainedArrayBufferBytes - working.retainedArrayBufferBytes,
    },
    null,
    2
  )
);
if (working.unreadBytes !== 0 || working.retainedArrayBufferBytes > options.chunkBytes) {
  process.exitCode = 1;
}
