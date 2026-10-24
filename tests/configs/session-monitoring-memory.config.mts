import { createCoverageConfig } from "../vitest.base.mts";

export default createCoverageConfig({
  name: "session-monitoring-memory",
  environment: "node",
  testFiles: [
    "tests/unit/actions/active-sessions-monitoring.test.ts",
    "tests/unit/lib/cache/session-cache.test.ts",
    "tests/unit/lib/cache/session-cache-load.test.ts",
  ],
  sourceFiles: ["src/lib/cache/session-cache.ts"],
  thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
});
