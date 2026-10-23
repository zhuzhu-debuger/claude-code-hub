import { createCoverageConfig } from "../vitest.base.mts";

export default createCoverageConfig({
  name: "proxy-response-memory",
  environment: "node",
  testFiles: [
    "src/app/v1/_lib/proxy/bounded-response-body.test.ts",
    "src/app/v1/_lib/proxy/response-fixer/sse-chunk-buffer.test.ts",
    "src/app/v1/_lib/proxy/response-fixer/response-fixer.test.ts",
    "tests/unit/proxy/response-handler-nonstream-terminal.test.ts",
  ],
  sourceFiles: [
    "src/app/v1/_lib/proxy/bounded-response-body.ts",
    "src/app/v1/_lib/proxy/response-fixer/sse-chunk-buffer.ts",
  ],
  thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
});
