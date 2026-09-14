import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // These tests do real git + SQLite file I/O; on a busy Windows machine a
    // single scenario can momentarily exceed the 5s default. Give them room.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
