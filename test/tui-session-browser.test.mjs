import assert from "node:assert/strict";
import { test } from "./harness.mjs";

async function flush(setup) {
  await new Promise((resolve) => setTimeout(resolve, 25));
  await setup.flush();
}

async function waitForFrame(setup, predicate) {
  return setup.waitForFrame(predicate, { maxPasses: 100 });
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
    preview: {
      turns: [
        { user: "Build a session switcher", assistant: "I will inspect the session formats." },
        { user: "Polish the terminal UI", assistant: "The layout now uses compact navigation." },
      ],
    },
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

  loading.resolve(sessions);
  await flush(setup);
  const frame = setup.captureCharFrame();
  assert.match(frame, /SESSIONS/);
  assert.match(frame, /Add session switcher/);
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
  const loading = deferred();
  let tick;
  let cleared = 0;

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    clock: {
      setInterval(callback) { tick = callback; return 7; },
      clearInterval(id) { if (id === 7) cleared += 1; },
    },
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: () => loading.promise,
  });
  await flush(setup);
  assert.match(setup.captureCharFrame(), /● · · ·/);

  tick();
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /· ● · ·/);

  loading.resolve([]);
  await flush(setup);
  assert.equal(cleared, 1);
  assert.match(setup.captureCharFrame(), /No sessions in current repo/);

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("session browser는 로딩 중 부분 결과를 즉시 렌더링하고 이동을 허용한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 100, height: 20 });
  t.after(() => setup.renderer.destroy());
  const loading = deferred();
  let selectedTitle = null;

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    cwd: "/repo/worktrees/feature",
    discoverScope: async () => ({ roots: ["/repo", "/repo/worktrees/feature"] }),
    sessionLoader: async ({ onUpdate }) => {
      onUpdate([sessions[0]]);
      return loading.promise;
    },
    onSelect: async (session) => {
      selectedTitle = session.title;
      return 0;
    },
  });

  await flush(setup);
  let frame = setup.captureCharFrame();
  assert.match(frame, /Add session switcher/);
  assert.match(frame, /Loading sessions/);

  setup.mockInput.pressKey("down");
  await flush(setup);
  await setup.mockInput.pressEnter();
  assert.equal(await result, 0);
  assert.equal(selectedTitle, "Add session switcher");
});

test("로딩 중 체크하면 선택 안내가 스피너보다 우선한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 100, height: 20 });
  t.after(() => setup.renderer.destroy());
  const loading = deferred();

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async ({ onUpdate }) => {
      onUpdate([{ ...sessions[0], cwd: "/repo" }]);
      return loading.promise;
    },
  });
  await flush(setup);
  assert.match(setup.captureCharFrame(), /Loading sessions/);

  setup.mockInput.pressKey(" ");
  await flush(setup);
  const frame = setup.captureCharFrame();
  assert.match(frame, /\[x\] CODEX/);
  assert.match(frame, /1 selected · c convert/);
  assert.doesNotMatch(frame, /Loading sessions/);

  // First Backspace clears the batch, second one exits.
  setup.mockInput.pressBackspace();
  await flush(setup);
  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("로딩이 끝나도 변환된 provider가 되돌아가지 않는다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 90, height: 16 });
  t.after(() => setup.renderer.destroy());
  const loading = deferred();

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async ({ onUpdate }) => {
      onUpdate([{ ...sessions[0], cwd: "/repo" }]);
      return loading.promise;
    },
    providerConverter: async (selected) => selected.length,
  });
  await flush(setup);

  setup.mockInput.pressKey(" ");
  setup.mockInput.pressKey("c");
  await waitForFrame(setup, (frame) => frame.includes("CONVERT PROVIDER"));
  setup.mockInput.pressEnter();
  await waitForFrame(setup, (frame) => frame.includes("converted to openai"));
  assert.match(setup.captureCharFrame(), /CODEX · openai/);

  // The scan was already reading rows before the conversion, so its result still says zgap.
  loading.resolve([{ ...sessions[0], cwd: "/repo" }]);
  await flush(setup);
  const frame = setup.captureCharFrame();
  assert.match(frame, /CODEX · openai/);
  assert.doesNotMatch(frame, /CODEX · zgap/);

  setup.mockInput.pressBackspace();
  await flush(setup);
  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("session browser는 scope, agent, 숫자 provider tab을 적용한다", async (t) => {
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
  let frame = setup.captureCharFrame();
  assert.match(frame, /\[1\]All/);
  assert.match(frame, /\[2\]zgap 1/);
  assert.doesNotMatch(frame, /openai 1/);

  setup.mockInput.pressKey("s");
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /\[s all\]/);
  assert.match(frame, /\[2\]openai 1/);
  assert.match(frame, /\[3\]zgap 1/);
  assert.match(frame, /Investi/);

  setup.mockInput.pressKey("a");
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /\[a codex\]/);
  assert.doesNotMatch(frame, /Review parser/);

  setup.mockInput.pressKey("2");
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /Investi/);
  assert.doesNotMatch(frame, /Add session switcher/);

  setup.mockInput.pressKey("3");
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /Add session switcher/);
  assert.doesNotMatch(frame, /Investi/);

  setup.mockInput.pressKey("1");
  setup.mockInput.pressKey("a");
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /\[a claude\]/);
  assert.match(frame, /Review parser/);

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("session browser는 C안의 agent, provider, 선택 색상을 표시한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 100, height: 20 });
  t.after(() => setup.renderer.destroy());

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => [
      { ...sessions[0], cwd: "/repo" },
      { ...sessions[1], cwd: "/repo" },
      { ...sessions[1], id: "codex-dynamic", provider: "new-provider", cwd: "/repo", title: "Dynamic provider" },
      sessions[2],
    ],
  });
  await flush(setup);

  const captured = setup.captureSpans();
  const spans = captured.lines.flatMap((line) => line.spans);
  const spanFor = (text) => spans.find((span) => span.text.includes(text));
  const rgba = (color) => Array.from(color.buffer);
  const codex = spanFor("CODEX");
  const claude = spanFor("CLAUDE");
  const zgap = spans.find((span) => span.text === "zgap");
  const openai = spans.find((span) => span.text === "openai");
  const dynamic = spans.find((span) => span.text === "new-provider");

  assert.deepEqual(rgba(codex.fg), [251, 191, 36, 255]);
  assert.deepEqual(rgba(claude.fg), [251, 113, 133, 255]);
  assert.notDeepEqual(rgba(zgap.fg), rgba(openai.fg));
  assert.notDeepEqual(rgba(openai.fg), rgba(dynamic.fg));
  assert.deepEqual(rgba(codex.bg), [39, 23, 8, 255]);
  assert.deepEqual(rgba(zgap.bg), [39, 23, 8, 255]);
  assert.deepEqual(rgba(spanFor("Add session switcher").bg), [39, 23, 8, 255]);

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("session browser는 실행 중인 세션에 초록 circleHalves 애니메이션을 표시한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 100, height: 20 });
  t.after(() => setup.renderer.destroy());
  let tick;
  let interval;

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    clock: {
      setInterval(callback, milliseconds) { tick = callback; interval = milliseconds; return 1; },
      clearInterval() {},
    },
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => [{ ...sessions[0], cwd: "/repo", active: true }],
  });
  await flush(setup);

  assert.equal(interval, 50);
  let spans = setup.captureSpans().lines.flatMap((line) => line.spans);
  let active = spans.find((span) => span.text.includes("◐"));
  assert.ok(active);
  assert.deepEqual(Array.from(active.fg.buffer), [110, 231, 183, 255]);

  tick();
  await setup.renderOnce();
  spans = setup.captureSpans().lines.flatMap((line) => line.spans);
  active = spans.find((span) => span.text.includes("◓"));
  assert.ok(active);
  assert.deepEqual(Array.from(active.fg.buffer), [110, 231, 183, 255]);

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("compact 너비는 활성 provider tab만 표시하고 숫자 키는 유지한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 40, height: 10 });
  t.after(() => setup.renderer.destroy());

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    now: () => sessions[0].updatedAt,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => [
      { ...sessions[0], cwd: "/repo" },
      { ...sessions[1], cwd: "/repo" },
    ],
  });
  await flush(setup);
  let frame = setup.captureCharFrame();
  assert.match(frame, /\[1\]All/);
  assert.doesNotMatch(frame, /\[2\]/);

  setup.mockInput.pressKey("3");
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /\[3\]zgap/);
  assert.doesNotMatch(frame, /\[1\]All/);
  assert.match(frame, /Add session sw/);
  assert.equal(frame.split("\n").every((line) => Bun.stringWidth(line) <= 40), true);

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("Space는 Codex row를 체크하고 Claude row에는 안내를 보여준다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 100, height: 20 });
  t.after(() => setup.renderer.destroy());

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => [
      { ...sessions[0], cwd: "/repo" },
      { ...sessions[2], cwd: "/repo" },
    ],
  });
  await flush(setup);
  let frame = setup.captureCharFrame();
  assert.match(frame, /\[ \] CODEX/);
  assert.doesNotMatch(frame.split("\n").find((line) => line.includes("CLAUDE")), /\[ \]/);

  setup.mockInput.pressKey(" ");
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /\[x\] CODEX/);
  assert.match(frame, /1 selected · c convert/);

  setup.mockInput.pressKey(" ");
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /\[ \] CODEX/);
  assert.doesNotMatch(frame, /selected/);

  setup.mockInput.pressArrow("down");
  setup.mockInput.pressKey(" ");
  await flush(setup);
  assert.match(setup.captureCharFrame(), /Only saved Codex sessions can be checked/);

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("Esc는 체크가 있으면 선택만 해제하고 다음 Esc로 종료한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 100, height: 20 });
  t.after(() => setup.renderer.destroy());

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => [{ ...sessions[0], cwd: "/repo" }],
  });
  await flush(setup);

  setup.mockInput.pressKey(" ");
  await flush(setup);
  assert.match(setup.captureCharFrame(), /\[x\] CODEX/);

  setup.mockInput.pressEscape();
  await flush(setup);
  assert.match(setup.captureCharFrame(), /\[ \] CODEX/);

  setup.mockInput.pressEscape();
  assert.equal(await result, 0);
});

test("c는 체크 없이는 안내를 보여주고 체크된 세션으로 변환 화면을 연다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 72, height: 12 });
  t.after(() => setup.renderer.destroy());

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => [
      { ...sessions[0], cwd: "/repo" },
      { ...sessions[1], cwd: "/repo" },
    ],
  });
  await flush(setup);

  setup.mockInput.pressKey("c");
  await flush(setup);
  assert.match(setup.captureCharFrame(), /Check sessions with Space first/);

  setup.mockInput.pressKey(" ");
  setup.mockInput.pressKey("c");
  await waitForFrame(setup, (frame) => frame.includes("CONVERT PROVIDER"));
  const frame = setup.captureCharFrame();
  assert.match(frame, /1 session will change/);
  assert.match(frame, /openai/);
  assert.doesNotMatch(frame, /›\s+zgap/);

  setup.mockInput.pressEscape();
  await flush(setup);
  assert.match(setup.captureCharFrame(), /\[x\] CODEX/);

  await setup.mockInput.pressBackspace();
  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("혼합 provider 체크는 target과 같은 세션을 제외한 개수로 변환한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 72, height: 14 });
  t.after(() => setup.renderer.destroy());
  const converted = [];
  const sourceSessions = [
    { ...sessions[0], cwd: "/repo" },
    { ...sessions[0], id: "codex-zgap-two", cwd: "/repo", title: "Second zgap session" },
    { ...sessions[1], cwd: "/repo" },
  ];

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => sourceSessions,
    providerConverter: async (selected, target) => {
      converted.push({ ids: selected.map(({ id }) => id), target });
      return selected.length;
    },
  });
  await flush(setup);

  setup.mockInput.pressKey(" ");
  setup.mockInput.pressArrow("down");
  setup.mockInput.pressKey(" ");
  setup.mockInput.pressArrow("down");
  setup.mockInput.pressKey(" ");
  setup.mockInput.pressKey("c");
  await waitForFrame(setup, (frame) => frame.includes("CONVERT PROVIDER"));
  let frame = setup.captureCharFrame();
  assert.match(frame, /1 of 3 selected sessions will change/);

  setup.mockInput.pressArrow("down");
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /2 of 3 selected sessions will change/);

  setup.mockInput.pressEnter();
  await waitForFrame(setup, (value) => value.includes("2 sessions converted to openai"));
  frame = setup.captureCharFrame();
  assert.deepEqual(converted, [{ ids: ["codex-zgap", "codex-zgap-two"], target: "openai" }]);
  assert.match(frame, /\[✓\] CODEX · openai {2}Add session/);
  assert.match(frame, /\[✓\] CODEX · openai {2}Second zgap/);
  assert.match(frame, /\[ \] CODEX · openai {2}Investigate auth/);
  assert.match(frame, /\[1\]All/);

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("변환 후 커서는 변환 직전에 있던 행에 남는다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 72, height: 14 });
  t.after(() => setup.renderer.destroy());
  const sourceSessions = [
    { ...sessions[0], cwd: "/repo" },
    { ...sessions[0], id: "codex-zgap-two", cwd: "/repo", title: "Second zgap session" },
    { ...sessions[2], cwd: "/repo" },
  ];

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => sourceSessions,
    providerConverter: async (selected) => selected.length,
  });
  await flush(setup);

  // Check the first row, then park the cursor on the Claude row that conversion never touches.
  setup.mockInput.pressKey(" ");
  setup.mockInput.pressArrow("down");
  setup.mockInput.pressArrow("down");
  await flush(setup);
  assert.match(setup.captureCharFrame(), /› {7}CLAUDE {2}Review parser/);

  setup.mockInput.pressKey("c");
  await waitForFrame(setup, (frame) => frame.includes("CONVERT PROVIDER"));
  setup.mockInput.pressEnter();
  await waitForFrame(setup, (frame) => frame.includes("1 session converted to openai"));
  assert.match(setup.captureCharFrame(), /› {7}CLAUDE {2}Review parser/);

  // Cursor on a converted row: its key changes with the provider, so it must be recomputed.
  setup.mockInput.pressArrow("up");
  setup.mockInput.pressKey(" ");
  setup.mockInput.pressKey("c");
  await waitForFrame(setup, (frame) => frame.includes("CONVERT PROVIDER"));
  setup.mockInput.pressEnter();
  await waitForFrame(setup, (frame) => /› {3}\[✓\] CODEX · openai {2}Second zgap/.test(frame));

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("변환 후 다른 scope 캐시를 비워 stale provider 목록을 막는다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 72, height: 12 });
  t.after(() => setup.renderer.destroy());
  const loads = [];
  const makeSession = (over) => ({ agent: "codex", cwd: "/repo", updatedAt: sessions[0].updatedAt, ...over });

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async ({ scope }) => {
      loads.push(scope);
      return scope === "repo"
        ? [makeSession({ id: "r1", provider: loads.filter((value) => value === "repo").length > 1 ? "openai" : "zgap", title: "Repo session" })]
        : [makeSession({ id: "r1", provider: "openai", title: "Repo session" }), makeSession({ id: "o1", cwd: "/other", provider: "openai", title: "Other session" })];
    },
    providerConverter: async (selected) => selected.length,
  });
  await flush(setup);
  setup.mockInput.pressKey("s");
  await flush(setup);
  setup.mockInput.pressKey("s");
  await flush(setup);
  assert.deepEqual(loads, ["repo", "all"]);

  setup.mockInput.pressKey(" ");
  setup.mockInput.pressKey("c");
  await waitForFrame(setup, (frame) => frame.includes("CONVERT PROVIDER"));
  setup.mockInput.pressEnter();
  await waitForFrame(setup, (frame) => frame.includes("1 session converted to openai"));

  setup.mockInput.pressKey("s");
  await waitForFrame(setup, (frame) => frame.includes("Other session"));
  assert.deepEqual(loads, ["repo", "all", "all"]);
  assert.match(setup.captureCharFrame(), /\[2\]openai 2/);

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("변환 실패는 변환 화면에 오류를 보여주고 선택을 유지한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 72, height: 12 });
  t.after(() => setup.renderer.destroy());

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => [{ ...sessions[0], cwd: "/repo" }],
    providerConverter: async () => { throw new Error("database is locked"); },
  });
  await flush(setup);

  setup.mockInput.pressKey(" ");
  setup.mockInput.pressKey("c");
  await waitForFrame(setup, (frame) => frame.includes("CONVERT PROVIDER"));
  setup.mockInput.pressEnter();
  await waitForFrame(setup, (frame) => frame.includes("Could not convert sessions"));
  assert.match(setup.captureCharFrame(), /database is locked/);

  setup.mockInput.pressEscape();
  await flush(setup);
  assert.match(setup.captureCharFrame(), /\[x\] CODEX · zgap/);

  await setup.mockInput.pressBackspace();
  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("session browser는 Page Up/Down, Home, End로 목록을 이동한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 100, height: 12 });
  t.after(() => setup.renderer.destroy());
  const navigationSessions = Array.from({ length: 7 }, (_, index) => ({
    ...sessions[0],
    id: `session-${index + 1}`,
    cwd: "/repo",
    title: `Session ${index + 1}`,
  }));

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => navigationSessions,
  });
  await flush(setup);

  setup.mockInput.pressKey("\x1b[6~");
  await flush(setup);
  assert.match(setup.captureCharFrame(), /›\s+\[ \] CODEX · zgap {2}Session 4/);

  setup.mockInput.pressKey("\x1b[5~");
  await flush(setup);
  assert.match(setup.captureCharFrame(), /›\s+\[ \] CODEX · zgap {2}Session 1/);

  setup.mockInput.pressKey("\x1b[H");
  await flush(setup);
  assert.match(setup.captureCharFrame(), /›\s+\[ \] CODEX · zgap {2}Session 1/);

  setup.mockInput.pressKey("\x1b[F");
  await flush(setup);
  assert.match(setup.captureCharFrame(), /›\s+\[ \] CODEX · zgap {2}Session 7/);

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("session browser는 Tab으로 첫 U/A와 마지막 U/A를 미리 본다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 40, height: 10 });
  t.after(() => setup.renderer.destroy());

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => [{ ...sessions[0], cwd: "/repo" }],
  });
  await flush(setup);

  setup.mockInput.pressKey("\t");
  await flush(setup);
  let frame = setup.captureCharFrame();
  assert.match(frame, /PREVIEW · Tab\/Esc close/);
  assert.match(frame, /U Build a session switcher/);
  assert.match(frame, /A I will inspect the session/);
  assert.match(frame, /formats\./);
  assert.match(frame, /U Polish the terminal UI/);
  assert.match(frame, /A The layout now uses compact navig…/);
  assert.doesNotMatch(frame, /› \[ \] CODEX/);

  const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
  const rgba = (color) => Array.from(color.buffer);
  const userLabel = spans.find((span) => span.text.startsWith("U "));
  const assistantLabel = spans.find((span) => span.text.startsWith("A "));
  assert.notDeepEqual(rgba(userLabel.fg), rgba(assistantLabel.fg));

  setup.mockInput.pressKey("\t");
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /›\s+\[ \] CODEX · zgap {2}Add session/);

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("미리보기의 Enter는 세션을 그대로 재개한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 100, height: 18 });
  t.after(() => setup.renderer.destroy());
  const originalSession = { ...sessions[0], cwd: "/repo" };
  let selectedSession;

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => [originalSession],
    onSelect: async (session) => {
      selectedSession = session;
      return 17;
    },
  });
  await flush(setup);

  setup.mockInput.pressKey("\t");
  await flush(setup);
  const frame = setup.captureCharFrame();
  assert.match(frame, /U Build a session switcher/);

  setup.mockInput.pressEnter();
  assert.equal(await result, 17);
  assert.equal(selectedSession, originalSession);
  assert.equal(originalSession.provider, "zgap");
});

test("작은 preview는 첫 turn과 마지막 turn 사이의 생략 수를 표시한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 40, height: 10 });
  t.after(() => setup.renderer.destroy());
  const turns = Array.from({ length: 5 }, (_, index) => ({
    user: `Question ${index + 1}`,
    assistant: `Answer ${index + 1}`,
  }));

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => [{ ...sessions[0], cwd: "/repo", preview: { turns } }],
  });
  await flush(setup);
  setup.mockInput.pressKey("\t");
  await flush(setup);

  const frame = setup.captureCharFrame();
  assert.match(frame, /U Question 1/);
  assert.match(frame, /A Answer 1/);
  assert.match(frame, /3 turns omitted/);
  assert.match(frame, /U Question 5/);
  assert.match(frame, /A Answer 5/);
  assert.doesNotMatch(frame, /Question 2/);

  setup.mockInput.pressKey("\t");
  await flush(setup);
  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("높은 preview는 중간 turn과 메시지의 두 번째 줄을 추가한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 40, height: 18 });
  t.after(() => setup.renderer.destroy());
  const turns = [
    { user: "First question wraps onto the second visual row", assistant: "First answer" },
    { user: "Question 2", assistant: "Answer 2" },
    { user: "Question 3", assistant: "Answer 3" },
    { user: "Question 4", assistant: "Answer 4" },
    { user: "Question 5", assistant: "Answer 5" },
  ];

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => [{ ...sessions[0], cwd: "/repo", preview: { turns } }],
  });
  await flush(setup);
  setup.mockInput.pressKey("\t");
  await flush(setup);

  const frame = setup.captureCharFrame();
  assert.match(frame, /U Question 3/);
  assert.match(frame, /A Answer 3/);
  assert.match(frame, /second visual row/);
  assert.doesNotMatch(frame, /turns omitted/);

  setup.mockInput.pressKey("\t");
  await flush(setup);
  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("session browser는 선택한 세션의 미리보기만 지연 로드한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 40, height: 10 });
  t.after(() => setup.renderer.destroy());
  const preview = deferred();
  const calls = [];
  const selected = {
    ...sessions[0], cwd: "/repo", preview: { turns: [] },
    previewLocator: { type: "jsonl", path: "/session.jsonl" },
  };

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => [selected],
    previewLoader: async (session) => { calls.push(session.id); return preview.promise; },
  });
  await flush(setup);

  setup.mockInput.pressKey("\t");
  await flush(setup);
  assert.deepEqual(calls, ["codex-zgap"]);
  assert.match(setup.captureCharFrame(), /Loading preview/);

  preview.resolve({
    turns: [
      { user: "First question", assistant: "First answer" },
      { user: "Last question", assistant: "Last answer" },
    ],
  });
  await flush(setup);
  const frame = setup.captureCharFrame();
  assert.match(frame, /U First question/);
  assert.match(frame, /A Last answer/);

  setup.mockInput.pressKey("\t");
  await flush(setup);
  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("session browser는 Enter로 선택한 세션을 재개한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 72, height: 12 });
  t.after(() => setup.renderer.destroy());
  let selected;

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => [{ ...sessions[0], cwd: "/repo" }],
    onSelect: async (session) => { selected = session; return 23; },
  });
  await flush(setup);

  setup.mockInput.pressEnter();
  assert.equal(await result, 23);
  assert.equal(selected.id, "codex-zgap");
  assert.equal(setup.renderer.isDestroyed, true);
});

test("session browser는 실행 중인 세션을 목록에서 Enter 두 번으로 재개한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 72, height: 12 });
  t.after(() => setup.renderer.destroy());
  let selected = false;

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => [{ ...sessions[0], cwd: "/repo", active: true }],
    onSelect: async () => { selected = true; return 23; },
  });
  await flush(setup);

  setup.mockInput.pressEnter();
  await waitForFrame(setup, (frame) => frame.includes("already running"));
  assert.equal(selected, false);

  setup.mockInput.pressEnter();
  assert.equal(await result, 23);
  assert.equal(selected, true);
});

test("session browser는 실행 중인 Codex 세션을 미리보기에서 Enter 두 번으로 재개한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 72, height: 12 });
  t.after(() => setup.renderer.destroy());
  let selected = false;

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => [{ ...sessions[0], cwd: "/repo", active: true }],
    onSelect: async () => { selected = true; return 23; },
  });
  await flush(setup);

  setup.mockInput.pressKey("\t");
  await waitForFrame(setup, (frame) => frame.includes("PREVIEW"));
  setup.mockInput.pressEnter();
  await waitForFrame(setup, (frame) => frame.includes("already running"));
  assert.equal(selected, false);

  setup.mockInput.pressEnter();
  assert.equal(await result, 23);
  assert.equal(selected, true);
});

test("session browser는 최근 상대 시간과 오래된 정확한 시간을 표시한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 100, height: 16 });
  t.after(() => setup.renderer.destroy());
  const details = deferred();
  const previewCalls = [];
  const now = new Date(2026, 7, 15, 14, 30).getTime();

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    now: () => now,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => [
      {
        ...sessions[0],
        cwd: "/repo",
        title: "Recent session",
        updatedAt: now - 5 * 60_000,
      },
      {
        ...sessions[1],
        cwd: "/repo",
        title: "Today session",
        updatedAt: now - 3 * 60 * 60_000,
      },
      {
        ...sessions[2],
        cwd: "/repo",
        title: "Previous day session",
        updatedAt: new Date(2026, 7, 14, 23, 45).getTime(),
      },
    ],
    detailsLoader: async () => details.promise,
    previewLoader: async (session) => { previewCalls.push(session.id); return { turns: [] }; },
  });
  await flush(setup);
  const frame = setup.captureCharFrame();
  assert.match(frame, /5m ago/);
  assert.match(frame, /11:30/);
  assert.match(frame, /2026-08-14 23:45/);

  details.resolve({
    turnCount: 12,
    fileSize: 1536,
    preview: { turns: [{ user: "cached question", assistant: "cached answer" }] },
  });
  await waitForFrame(setup, (frame) => frame.includes("12 turns") && frame.includes("1.5 KB"));
  const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
  const rgba = (color) => Array.from(color.buffer);
  const relativeTime = spans.find((span) => span.text === "5m ago");
  const turnCount = spans.find((span) => span.text === "12 turns");
  const fileSize = spans.find((span) => span.text === "1.5 KB");
  assert.notDeepEqual(rgba(relativeTime.fg), rgba(turnCount.fg));
  assert.notDeepEqual(rgba(turnCount.fg), rgba(fileSize.fg));

  setup.mockInput.pressKey("\t");
  await waitForFrame(setup, (frame) => frame.includes("U cached question") && frame.includes("A cached answer"));
  assert.deepEqual(previewCalls, []);
  setup.mockInput.pressKey("\t");

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("session browser는 ? 키로 단축키 화면을 열고 닫는다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 44, height: 12 });
  t.after(() => setup.renderer.destroy());

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => sessions,
  });
  await flush(setup);

  setup.mockInput.pressKey("?");
  await waitForFrame(setup, (value) => value.includes("PgUp/PgDn") && value.includes("Esc/Backspace"));
  let frame = setup.captureCharFrame();
  assert.match(frame, /PgUp\/PgDn/);
  assert.match(frame, /Home\/End/);
  assert.match(frame, /Tab Preview/);
  assert.match(frame, /Space Check · c Convert provider/);
  assert.match(frame, /Esc\/Backspace Back/);
  assert.match(frame, /\^C×2 Quit/);
  assert.doesNotMatch(frame, /Add session switcher/);

  setup.mockInput.pressKey("?");
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /\[1\]All/);
  assert.match(frame, /Add session/);

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("session browser는 한글 제목을 행 너비 안에서 줄인다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 40, height: 10 });
  t.after(() => setup.renderer.destroy());
  // 고정 updatedAt은 날짜가 지나면 16칸짜리 정확한 시간 표기로 바뀌어 좁은 행에서 위치를 밀어낸다.
  const now = sessions[0].updatedAt + 5 * 60_000;

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    now: () => now,
    discoverScope: async () => ({ roots: ["/repo"] }),
    // Pinned clock: the fixture's updatedAt is absolute, so a real Date.now() would flip the
    // meta line to an exact timestamp after 3 hours and push the location label out of width 40.
    now: () => sessions[0].updatedAt + 5 * 60_000,
    sessionLoader: async () => [{
      ...sessions[0],
      cwd: "/repo",
      title: "세션 목록을 보여주는 아주 긴 한글 제목입니다",
    }],
  });
  await flush(setup);

  const frame = setup.captureCharFrame();
  assert.match(frame, /세션 목록을 보/);
  assert.match(frame, /└ repo/);

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("session browser는 작은 terminal에서 두 session row를 표시하고 viewport를 이동한다", async (t) => {
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
      { ...sessions[0], id: "third", cwd: "/repo", title: "Third session" },
    ],
  });
  await flush(setup);

  let frame = setup.captureCharFrame();
  assert.match(frame, /SESSIONS/);
  assert.match(frame, /First session/);
  assert.match(frame, /Second session/);
  assert.doesNotMatch(frame, /Third session/);
  assert.doesNotMatch(frame, /\d{1,2}\/\d{1,2}\/\d{2}/);
  assert.match(frame, /\[s repo\] \[a all\] \[1\]All/);

  setup.mockInput.pressArrow("down");
  setup.mockInput.pressArrow("down");
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /Second session/);
  assert.doesNotMatch(frame, /First session/);
  assert.match(frame, /Third session/);

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
  assert.match(frame, /CODEX · openai {2}Safe title/);
  assert.match(frame, /└ worktree/);

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("session browser는 긴 provider와 위치를 terminal 너비 안에서 줄인다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 40, height: 10 });
  t.after(() => setup.renderer.destroy());

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    now: () => sessions[0].updatedAt,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => [{
      ...sessions[0],
      provider: "enterprise-proxy-provider-with-long-name",
      cwd: "/repo/worktrees/a-very-long-worktree-directory-name",
    }],
  });
  await flush(setup);

  setup.mockInput.pressKey("2");
  await flush(setup);
  const frame = setup.captureCharFrame();
  assert.match(frame, /\[2\]enterprise-…/);
  assert.match(frame, /└ a-very-long-wor…/);
  assert.match(frame, /2t/);
  assert.match(frame, /0 B/);
  assert.equal(frame.split("\n").every((line) => Bun.stringWidth(line) <= 40), true);

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
  assert.match(frame, /\[s all\]/);
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

test("session browser는 root Esc 한 번으로 뒤로 간다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 72, height: 12 });
  t.after(() => setup.renderer.destroy());

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => sessions,
  });
  await flush(setup);

  setup.mockInput.pressEscape();
  assert.equal(await Promise.race([
    result,
    new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
  ]), 0);
});
