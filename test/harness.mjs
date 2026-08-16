import { test as bunTest } from "bun:test";

// bun's runner drops node:test suites whenever registration overlaps another file's
// execution, so the whole test tree silently shrinks under a full `bun test`. This wraps
// bun:test with the only node:test context feature the suites use: `t.after(cleanup)`.
export function test(name, fn) {
  bunTest(name, async () => {
    const cleanups = [];
    const context = { after: (cleanup) => { cleanups.push(cleanup); } };
    try {
      await fn(context);
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
    }
  });
}
