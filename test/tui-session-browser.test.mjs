import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";

const test = (name, options, fn) => typeof options === "function"
  ? nodeTest(name, { concurrency: false }, options)
  : nodeTest(name, { ...options, concurrency: false }, fn);

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
  assert.doesNotMatch(setup.captureCharFrame(), /Add session switcher/);

  loading.resolve(sessions);
  await flush(setup);
  const frame = setup.captureCharFrame();
  assert.match(frame, /\[s repo\] \[a all\] \[p all\]/);
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
  let interval;

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    clock: {
      setInterval(callback, milliseconds) { tick = callback; interval = milliseconds; return 1; },
      clearInterval(handle) { assert.equal(handle, 1); cleared += 1; },
    },
    discoverScope: () => scope.promise,
    sessionLoader: () => loading.promise,
  });

  await flush(setup);
  assert.equal(interval, 90);
  assert.match(setup.captureCharFrame(), /● · · · Initializing sessions/);
  tick();
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /· ● · · Initializing sessions/);

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
  assert.match(frame, /\[s all\]/);
  assert.match(frame, /Investi/);

  setup.mockInput.pressKey("a");
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /\[a codex\]/);
  assert.doesNotMatch(frame, /Review parser/);

  setup.mockInput.pressKey("p");
  await waitForFrame(setup, (value) => value.includes("› ● All"));
  frame = setup.captureCharFrame();
  assert.match(frame, /PROVIDER · p\/Esc close/);
  assert.match(frame, /› ● All/);
  assert.match(frame, /openai/);
  assert.match(frame, /zgap/);

  setup.mockInput.pressArrow("down");
  setup.mockInput.pressEnter();
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /\[p openai\]/);
  assert.match(frame, /Investi/);
  assert.doesNotMatch(frame, /Add session switcher/);

  setup.mockInput.pressKey("p");
  setup.mockInput.pressArrow("down");
  setup.mockInput.pressEnter();
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /\[p zgap\]/);
  assert.match(frame, /Add session switcher/);

  setup.mockInput.pressKey("p");
  setup.mockInput.pressKey("\x1b[H");
  setup.mockInput.pressEnter();
  setup.mockInput.pressKey("a");
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /\[a claude\]/);
  assert.match(frame, /\[p all\]/);
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
  const zgap = spanFor("zgap");
  const openai = spanFor("openai");
  const dynamic = spanFor("new-provider");

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

test("session browser는 compact filter chip에 현재 값을 갱신한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 100, height: 20 });
  t.after(() => setup.renderer.destroy());

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => sessions,
  });
  await flush(setup);
  assert.match(setup.captureCharFrame(), /\[s repo\] \[a all\] \[p all\]/);

  setup.mockInput.pressKey("s");
  await flush(setup);
  setup.mockInput.pressKey("a");
  await flush(setup);
  setup.mockInput.pressKey("p");
  setup.mockInput.pressArrow("down");
  setup.mockInput.pressEnter();
  await flush(setup);
  assert.match(setup.captureCharFrame(), /\[s all\] \[a codex\] \[p openai\]/);

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("session browser는 provider 선택을 Enter로 적용하고 p와 Esc로 닫는다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 40, height: 10 });
  t.after(() => setup.renderer.destroy());

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => [
      { ...sessions[0], cwd: "/repo" },
      { ...sessions[1], cwd: "/repo" },
      { ...sessions[1], id: "dynamic", provider: "enterprise-proxy", cwd: "/repo" },
    ],
  });
  await flush(setup);

  setup.mockInput.pressKey("p");
  await waitForFrame(setup, (value) => value.includes("› ● All"));
  let frame = setup.captureCharFrame();
  assert.match(frame, /PROVIDER · p\/Esc close/);
  assert.match(frame, /› ● All/);
  assert.match(frame, /enterprise-proxy/);
  assert.match(frame, /openai/);
  assert.match(frame, /zgap/);
  assert.doesNotMatch(frame, /Add session switcher/);

  setup.mockInput.pressArrow("down");
  setup.mockInput.pressKey(" ");
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /PROVIDER · p\/Esc close/);
  assert.doesNotMatch(frame, /\[p enterprise-…\]/);

  setup.mockInput.pressEnter();
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /\[p enterprise-…\]/);
  assert.match(frame, /Investi/);

  setup.mockInput.pressKey("p");
  setup.mockInput.pressKey("p");
  await flush(setup);
  assert.match(setup.captureCharFrame(), /Investi/);

  setup.mockInput.pressKey("p");
  setup.mockInput.pressEscape();
  await flush(setup);
  assert.match(setup.captureCharFrame(), /Investi/);
  assert.doesNotMatch(setup.captureCharFrame(), /Press Esc again to quit/);

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("provider menu는 source를 골라 c로 target과 변경 개수를 확인한 뒤 일괄 변환한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 72, height: 12 });
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

  setup.mockInput.pressKey("p");
  setup.mockInput.pressKey("\x1b[F");
  setup.mockInput.pressKey("c");
  await waitForFrame(setup, (frame) => frame.includes("CONVERT · zgap") && frame.includes("2 sessions will change"));
  let frame = setup.captureCharFrame();
  assert.match(frame, /CONVERT · zgap/);
  assert.match(frame, /2 sessions will change/);
  assert.match(frame, /openai/);

  setup.mockInput.pressEnter();
  await waitForFrame(setup, (value) => value.includes("[p openai]") && value.includes("Second zgap session"));
  frame = setup.captureCharFrame();
  assert.deepEqual(converted, [{ ids: ["codex-zgap", "codex-zgap-two"], target: "openai" }]);
  assert.match(frame, /\[p openai\]/);
  assert.match(frame, /CODEX · openai/);

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
  assert.match(setup.captureCharFrame(), /›\s+CODEX · zgap  Session 4/);

  setup.mockInput.pressKey("\x1b[5~");
  await flush(setup);
  assert.match(setup.captureCharFrame(), /›\s+CODEX · zgap  Session 1/);

  setup.mockInput.pressKey("\x1b[H");
  await flush(setup);
  assert.match(setup.captureCharFrame(), /›\s+CODEX · zgap  Session 1/);

  setup.mockInput.pressKey("\x1b[F");
  await flush(setup);
  assert.match(setup.captureCharFrame(), /›\s+CODEX · zgap  Session 7/);

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("session browser는 Space로 첫 U/A와 마지막 U/A를 미리 본다", async (t) => {
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

  setup.mockInput.pressKey(" ");
  await flush(setup);
  let frame = setup.captureCharFrame();
  assert.match(frame, /PREVIEW · Space\/Esc close/);
  assert.match(frame, /U Build a session switcher/);
  assert.match(frame, /A I will inspect the session/);
  assert.match(frame, /formats\./);
  assert.match(frame, /U Polish the terminal UI/);
  assert.match(frame, /A The layout now uses compact navig…/);
  assert.doesNotMatch(frame, /› CODEX/);

  const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
  const rgba = (color) => Array.from(color.buffer);
  const userLabel = spans.find((span) => span.text.startsWith("U "));
  const assistantLabel = spans.find((span) => span.text.startsWith("A "));
  assert.notDeepEqual(rgba(userLabel.fg), rgba(assistantLabel.fg));

  setup.mockInput.pressKey(" ");
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /›\s+CODEX · zgap  Add session/);

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("Codex preview는 wide rail에서 provider를 선택해 원본 세션을 보존한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 100, height: 18 });
  t.after(() => setup.renderer.destroy());
  const originalSession = { ...sessions[0], cwd: "/repo" };
  const codexSessions = [
    originalSession,
    { ...sessions[0], id: "codex-openai", provider: "openai", cwd: "/repo", title: "OpenAI session" },
    { ...sessions[0], id: "codex-agp", provider: "agp", cwd: "/repo", title: "AGP session" },
  ];
  let selectedSession;
  let selection;

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => codexSessions,
    onSelect: async (session, options) => {
      selectedSession = session;
      selection = options;
      return 17;
    },
  });
  await flush(setup);

  setup.mockInput.pressKey(" ");
  await flush(setup);
  let frame = setup.captureCharFrame();
  assert.match(frame, /RESUME WITH/);
  assert.match(frame, /› zgap/);
  assert.match(frame, /  openai/);
  assert.match(frame, /  agp/);
  assert.match(frame, /saved/);
  assert.match(frame, /U Build a session switcher/);
  assert.match(frame, /A I will inspect the session/);
  const wideRailLine = frame.split("\n").find((line) => line.includes("RESUME WITH"));
  assert.ok(wideRailLine.indexOf("RESUME WITH") > 40);

  setup.mockInput.pressArrow("down");
  await flush(setup);
  setup.mockInput.pressEnter();
  assert.equal(await result, 17);
  assert.equal(selectedSession, originalSession);
  assert.deepEqual(selection, { provider: "openai" });
  assert.equal(originalSession.provider, "zgap");
});

test("Codex wide rail은 저장된 provider 표식을 해당 행에 유지하고 없으면 표시하지 않는다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 100, height: 18 });
  t.after(() => setup.renderer.destroy());
  const saved = { ...sessions[0], cwd: "/repo" };
  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => [
      saved,
      { ...saved, id: "openai-session", provider: "openai", title: "OpenAI session" },
      { ...saved, id: "no-saved-session", provider: null, title: "Unconfigured provider" },
    ],
  });
  await flush(setup);
  setup.mockInput.pressKey(" ");
  await flush(setup);
  let frame = setup.captureCharFrame();
  const zgapLine = frame.split("\n").find((line) => line.includes("zgap"));
  assert.match(zgapLine, /saved/);
  assert.doesNotMatch(frame.split("\n").find((line) => line.includes("openai")), /saved/);

  setup.mockInput.pressArrow("down");
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame.split("\n").find((line) => line.includes("zgap")), /saved/);

  setup.mockInput.pressKey(" ");
  await flush(setup);
  setup.mockInput.pressArrow("down");
  setup.mockInput.pressArrow("down");
  await setup.mockInput.pressKey(" ");
  await flush(setup);
  assert.doesNotMatch(setup.captureCharFrame(), /saved/);
  await setup.mockInput.pressBackspace();
  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("Codex wide rail은 긴 provider를 22열 안에서 한 줄로 줄인다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 100, height: 18 });
  t.after(() => setup.renderer.destroy());
  const longProvider = "super-long-provider-name-that-breaks-rail";

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => [
      { ...sessions[0], cwd: "/repo" },
      { ...sessions[0], id: "codex-long", provider: longProvider, cwd: "/repo" },
    ],
  });
  await flush(setup);

  setup.mockInput.pressKey(" ");
  await flush(setup);
  const frame = setup.captureCharFrame();
  assert.match(frame, /super-long-provid…/);
  assert.doesNotMatch(frame, new RegExp(longProvider));
  assert.match(frame, /U Build a session switcher/);
  const providerLines = frame.split("\n").filter((line) => line.includes("super-long") || line.includes("name-that"));
  assert.equal(providerLines.length, 1);
  assert.ok(Bun.stringWidth(providerLines[0].slice(-22).trim()) <= 22);

  setup.mockInput.pressKey(" ");
  await flush(setup);
  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("Codex preview는 compact rail에서 모든 줄을 40열 안에 유지한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 40, height: 10 });
  t.after(() => setup.renderer.destroy());

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => [
      { ...sessions[0], cwd: "/repo" },
      { ...sessions[0], id: "codex-openai", provider: "openai", cwd: "/repo" },
      { ...sessions[0], id: "codex-agp", provider: "agp", cwd: "/repo" },
    ],
  });
  await flush(setup);

  setup.mockInput.pressKey(" ");
  await flush(setup);
  let frame = setup.captureCharFrame();
  assert.match(frame, /Provider 1\/3 · zgap/);
  assert.match(frame, /U Build a session switcher/);
  assert.match(frame, /A I will inspect the session/);
  assert.ok(frame.indexOf("Provider 1/3") < frame.indexOf("U Build a session switcher"));
  for (const line of frame.split("\n")) assert.ok(Bun.stringWidth(line) <= 40, line);

  setup.mockInput.pressArrow("down");
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /Provider 2\/3 · openai/);
  assert.match(frame, /zgap/);
  for (const line of frame.split("\n")) assert.ok(Bun.stringWidth(line) <= 40, line);

  setup.mockInput.pressKey(" ");
  await flush(setup);
  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("Codex wide preview는 짧은 rail viewport에서 End 선택을 보이고 그대로 재개한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 100, height: 10 });
  t.after(() => setup.renderer.destroy());
  const providers = ["zgap", "openai", "p1", "p2", "p3", "p4", "p5"];
  const base = { ...sessions[0], cwd: "/repo" };
  let selection;
  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => providers.map((provider, index) => ({ ...base, id: `provider-${index}`, provider })),
    onSelect: async (_session, options) => { selection = options; return 0; },
  });
  await flush(setup);
  setup.mockInput.pressKey(" ");
  await flush(setup);
  setup.mockInput.pressKey("\x1b[F");
  await flush(setup);
  const frame = setup.captureCharFrame();
  assert.match(frame, /› p5/);
  assert.doesNotMatch(frame, /› zgap/);
  setup.mockInput.pressEnter();
  assert.equal(await result, 0);
  assert.deepEqual(selection, { provider: "p5" });
});

test("Claude preview에는 provider rail이 없고 기존 닫기 동작을 유지한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 40, height: 10 });
  t.after(() => setup.renderer.destroy());
  let selected = false;

  const result = runSessionBrowser({
    rendererFactory: async () => setup,
    discoverScope: async () => ({ roots: ["/repo"] }),
    sessionLoader: async () => [{ ...sessions[2], cwd: "/repo", preview: {
      turns: [{ user: "Review parser behavior", assistant: "I will inspect the parser." }],
    } }],
    onSelect: async () => { selected = true; return 23; },
  });
  await flush(setup);

  setup.mockInput.pressKey(" ");
  await flush(setup);
  let frame = setup.captureCharFrame();
  assert.doesNotMatch(frame, /RESUME WITH|Provider/);
  assert.match(frame, /U Review parser behavior/);
  setup.mockInput.pressArrow("down");
  setup.mockInput.pressArrow("up");
  setup.mockInput.pressEnter();
  await flush(setup);
  assert.equal(selected, false);
  assert.match(setup.captureCharFrame(), /U Review parser behavior/);

  setup.mockInput.pressKey(" ");
  await flush(setup);
  assert.match(setup.captureCharFrame(), /›\s+CLAUDE/);
  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
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
  setup.mockInput.pressKey(" ");
  await flush(setup);

  const frame = setup.captureCharFrame();
  assert.match(frame, /U Question 1/);
  assert.match(frame, /A Answer 1/);
  assert.match(frame, /3 turns omitted/);
  assert.match(frame, /U Question 5/);
  assert.match(frame, /A Answer 5/);
  assert.doesNotMatch(frame, /Question 2/);

  setup.mockInput.pressKey(" ");
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
  setup.mockInput.pressKey(" ");
  await flush(setup);

  const frame = setup.captureCharFrame();
  assert.match(frame, /U Question 3/);
  assert.match(frame, /A Answer 3/);
  assert.match(frame, /second visual row/);
  assert.doesNotMatch(frame, /turns omitted/);

  setup.mockInput.pressKey(" ");
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

  setup.mockInput.pressKey(" ");
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

  setup.mockInput.pressKey(" ");
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

  setup.mockInput.pressKey(" ");
  await waitForFrame(setup, (frame) => frame.includes("RESUME WITH"));
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

  setup.mockInput.pressKey(" ");
  await waitForFrame(setup, (frame) => frame.includes("U cached question") && frame.includes("A cached answer"));
  assert.deepEqual(previewCalls, []);
  setup.mockInput.pressKey(" ");

  await setup.mockInput.pressBackspace();
  assert.equal(await result, 0);
});

test("session browser는 ? 키로 단축키 화면을 열고 닫는다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runSessionBrowser } = await import("../src/tui/session-browser.mjs");
  const setup = await createTestRenderer({ width: 40, height: 10 });
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
  assert.match(frame, /Esc\/Backspace Back/);
  assert.match(frame, /\^C×2 Quit/);
  assert.doesNotMatch(frame, /Add session switcher/);

  setup.mockInput.pressKey("?");
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /\[p all\]/);
  assert.match(frame, /Add session/);

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
  assert.match(frame, /세션 목록을 보여주/);
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
  assert.match(frame, /\[s repo\] \[a all\] \[p all\]/);

  setup.mockInput.pressArrow("down");
  setup.mockInput.pressArrow("down");
  await flush(setup);
  frame = setup.captureCharFrame();
  assert.match(frame, /Second session/);
  assert.doesNotMatch(frame, /First session/);
  assert.match(frame, /Third session/);
  assert.match(frame, /\[s repo\] \[a all\] \[p all\]/);

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
  assert.match(frame, /└ worktree/);

  setup.mockInput.pressKey("p");
  setup.mockInput.pressArrow("down");
  setup.mockInput.pressEnter();
  await flush(setup);
  assert.doesNotMatch(setup.captureCharFrame(), /\u001b|\u0007/);
  assert.match(setup.captureCharFrame(), /\[p openai\]/);

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

  setup.mockInput.pressKey("p");
  setup.mockInput.pressArrow("down");
  setup.mockInput.pressEnter();
  await flush(setup);
  const frame = setup.captureCharFrame();
  assert.match(frame, /\[p enterprise-…\]/);
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
