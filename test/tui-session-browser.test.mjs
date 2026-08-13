import assert from "node:assert/strict";
import { test } from "node:test";

async function flush(setup) {
  await new Promise((resolve) => setTimeout(resolve, 25));
  await setup.renderOnce();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const sessions = [
  {
    agent: "codex",
    provider: "zgap",
    id: "codex-zgap",
    cwd: "/repo/worktrees/feature",
    title: "Add session switcher",
    updatedAt: Date.parse("2026-08-14T00:00:00Z"),
  },
  {
    agent: "codex",
    provider: "openai",
    id: "codex-openai",
    cwd: "/other/repo",
    title: "Investigate auth",
    updatedAt: Date.parse("2026-08-13T23:00:00Z"),
  },
  {
    agent: "claude",
    provider: null,
    id: "claude-one",
    cwd: "/repo",
    title: "Review parser",
    updatedAt: Date.parse("2026-08-13T22:00:00Z"),
  },
];

test("session browser는 initializing, loading, repo 목록을 구분한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 100, height: 20 });
  t.after(() => setup.renderer.destroy());
  const scope = deferred();
  const loading = deferred();

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    cwd: "/repo/worktrees/feature",
    discoverScope: () => scope.promise,
    sessionLoader: () => loading.promise,
  });

  await flush(setup);
  assert.match(setup.captureCharFrame(), /Initializing sessions/);

  scope.resolve({ roots: ["/repo", "/repo/worktrees/feature"] });
  await flush(setup);
  assert.match(setup.captureCharFrame(), /Loading sessions/);
  assert.doesNotMatch(setup.captureCharFrame(), /Add session switcher/);

  loading.resolve(sessions);
  await flush(setup);
  const frame = setup.captureCharFrame();
  assert.match(frame, /Scope: Current repo/);
  assert.match(frame, /Agent: All/);
  assert.match(frame, /Provider: All/);
  assert.match(frame, /CODEX · zgap/);
  assert.match(frame, /Add session switcher/);
  assert.match(frame, /CLAUDE/);
  assert.match(frame, /Review parser/);
  assert.doesNotMatch(frame, /Investigate auth/);

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("session browser는 loading spinner를 움직이고 완료 후 timer를 정리한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 100, height: 20 });
  t.after(() => setup.renderer.destroy());
  const scope = deferred();
  const loading = deferred();
  let tick;
  let cleared = 0;

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    clock: {
      setInterval(callback) { tick = callback; return 1; },
      clearInterval(handle) { assert.equal(handle, 1); cleared += 1; },
    },
    discoverScope: () => scope.promise,
    sessionLoader: () => loading.promise,
  });

  await flush(setup);
  assert.match(setup.captureCharFrame(), /\| Initializing sessions/);
  tick();
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /\/ Initializing sessions/);

  scope.resolve({ roots: ["/repo"] });
  await flush(setup);
  assert.match(setup.captureCharFrame(), /Loading sessions/);

  loading.resolve([]);
  await flush(setup);
  assert.equal(cleared, 1);

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
  assert.equal(cleared, 1);
});

test("session browser는 scope, agent, provider filter와 목록 이동을 적용한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 100, height: 20 });
  t.after(() => setup.renderer.destroy());

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    cwd: "/repo/worktrees/feature",
    discoverScope: async () => ({ roots: ["/repo", "/repo/worktrees/feature"] }),
    sessionLoader: async () => sessions,
  });
  await flush(setup);

  setup.mockInput.pressKey("s");
  await flush(setup);
  let frame = setup.captureCharFrame();
  assert.match(frame, /Scope: All directories/);
  assert.match(frame, /Investigate auth/);

  setup.mockInput.pressKey("a");
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /Agent: Codex/);
  assert.doesNotMatch(frame, /Review parser/);

  setup.mockInput.pressKey("p");
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /Provider: openai/);
  assert.match(frame, /Investigate auth/);
  assert.doesNotMatch(frame, /Add session switcher/);

  setup.mockInput.pressKey("p");
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /Provider: zgap/);
  assert.match(frame, /Add session switcher/);

  setup.mockInput.pressKey("p");
  setup.mockInput.pressKey("a");
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /Agent: Claude/);
  assert.match(frame, /Provider: All/);
  assert.match(frame, /Review parser/);

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("session browser는 한글 제목을 행 너비 안에서 줄인다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 40, height: 10 });
  t.after(() => setup.renderer.destroy());

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => [{
      ...sessions[0],
      cwd: "/repo",
      title: "세션 목록을 보여주는 아주 긴 한글 제목입니다",
    }],
  });
  await flush(setup);

  const frame = setup.captureCharFrame();
  assert.match(frame, /세션 목록을 보여주…/);
  assert.match(frame, /\+  repo/);

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("session browser는 작은 terminal에서 한 session row만 표시하고 이동한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 40, height: 10 });
  t.after(() => setup.renderer.destroy());

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => [
      { ...sessions[0], cwd: "/repo", title: "First session" },
      { ...sessions[0], id: "second", cwd: "/repo", title: "Second session" },
    ],
  });
  await flush(setup);

  let frame = setup.captureCharFrame();
  assert.match(frame, /First session/);
  assert.doesNotMatch(frame, /Second session/);
  assert.match(frame, /s\/a\/p filter/);

  setup.mockInput.pressArrow("down");
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /Second session/);
  assert.doesNotMatch(frame, /First session/);
  assert.match(frame, /s\/a\/p filter/);

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("session browser는 로그의 terminal control sequence를 표시하지 않는다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 80, height: 12 });
  t.after(() => setup.renderer.destroy());

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => [{
      ...sessions[0],
      provider: "\u001b]0;provider\u0007openai",
      cwd: "/repo/\u001b[31mworktree\u001b[0m",
      title: "\u001b]0;title\u0007Safe title",
    }],
  });
  await flush(setup);

  const frame = setup.captureCharFrame();
  assert.doesNotMatch(frame, /\u001b|\u0007/);
  assert.match(frame, /CODEX · openai  Safe title/);
  assert.match(frame, /\+  worktree/);

  setup.mockInput.pressKey("p");
  await flush(setup);
  assert.doesNotMatch(setup.captureCharFrame(), /\u001b|\u0007/);
  assert.match(setup.captureCharFrame(), /Provider: openai/);

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("session browser는 repo를 먼저 읽고 All 전환 시 전체 session을 지연 로드한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 100, height: 20 });
  t.after(() => setup.renderer.destroy());
  const all = deferred();
  const calls = [];

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    cwd: "/repo",
    discoverScope: async () => ["/repo"],
    sessionLoader: async ({ scope }) => {
      calls.push(scope);
      if (scope === "repo") return [sessions[0], sessions[2]];
      return all.promise;
    },
  });
  await flush(setup);
  assert.deepEqual(calls, ["repo"]);
  assert.match(setup.captureCharFrame(), /Add session switcher/);

  setup.mockInput.pressKey("s");
  await flush(setup);
  assert.deepEqual(calls, ["repo", "all"]);
  assert.match(setup.captureCharFrame(), /Loading sessions/);
  assert.doesNotMatch(setup.captureCharFrame(), /Add session switcher/);

  setup.mockInput.pressKey("s");
  await flush(setup);
  assert.deepEqual(calls, ["repo", "all"]);
  assert.match(setup.captureCharFrame(), /Add session switcher/);
  assert.doesNotMatch(setup.captureCharFrame(), /Investigate auth/);

  all.resolve(sessions);
  await flush(setup);
  assert.match(setup.captureCharFrame(), /Add session switcher/);
  assert.doesNotMatch(setup.captureCharFrame(), /Investigate auth/);

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("session browser는 repository scope 탐색 중 All 전환을 유지한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 100, height: 20 });
  t.after(() => setup.renderer.destroy());
  const scope = deferred();
  const calls = [];

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: () => scope.promise,
    sessionLoader: async ({ scope: requestedScope }) => {
      calls.push(requestedScope);
      return requestedScope === "all" ? sessions : [sessions[0], sessions[2]];
    },
  });
  await flush(setup);

  setup.mockInput.pressKey("s");
  scope.resolve({ roots: ["/repo"] });
  await flush(setup);

  assert.deepEqual(calls, ["all"]);
  const frame = setup.captureCharFrame();
  assert.match(frame, /Scope: All directories/);
  assert.match(frame, /Investigate auth/);

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("session browser는 refresh 중 이전 목록을 지우고 새 snapshot을 표시한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 100, height: 20 });
  t.after(() => setup.renderer.destroy());
  const refresh = deferred();
  let loads = 0;

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    cwd: "/repo",
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => {
      loads += 1;
      if (loads === 1) return sessions;
      return refresh.promise;
    },
  });
  await flush(setup);
  assert.match(setup.captureCharFrame(), /Add session switcher/);

  setup.mockInput.pressKey("r");
  await flush(setup);
  let frame = setup.captureCharFrame();
  assert.match(frame, /Loading sessions/);
  assert.doesNotMatch(frame, /Add session switcher/);

  refresh.resolve([{ ...sessions[0], id: "new", title: "New snapshot" }]);
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /New snapshot/);
  assert.doesNotMatch(frame, /Review parser/);

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("session browser는 double quit와 renderer cleanup을 보존한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 72, height: 12 });
  t.after(() => setup.renderer.destroy());
  let now = 0;
  let destroyed = 0;
  const originalDestroy = setup.renderer.destroy.bind(setup.renderer);
  setup.renderer.destroy = () => { destroyed += 1; return originalDestroy(); };

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    now: () => now,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => [],
  });
  await flush(setup);
  assert.match(setup.captureCharFrame(), /No sessions in current repo/);

  await setup.mockInput.pressCtrlC();
  now = 500;
  await setup.mockInput.pressCtrlC();
  assert.equal(await result, 130);
  assert.equal(destroyed, 1);
});
