import assert from "node:assert/strict";
import { test } from "./harness.mjs";

async function flushMenu(setup) {
  await new Promise((resolve) => setTimeout(resolve, 25));
  await setup.renderOnce();
}

test("TUI는 이메일만 표시하고 백그라운드 업데이트 완료 날짜를 반영한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runStartMenu } = await import("../src/tui/menu.mjs");
  const setup = await createTestRenderer({ width: 100, height: 24 });
  t.after(() => setup.renderer.destroy());
  let resolveUpdate;
  const updatePromise = new Promise((resolve) => { resolveUpdate = resolve; });
  const resultPromise = runStartMenu({
    rendererFactory: async () => setup,
    credentialState: "signed-in",
    accountProfile: {
      email: "user@example.com",
      emailVerified: true,
      proxyProducts: [
        { id: "codex", origin: "https://ai-proxy.zz.gg" },
        { id: "claude", origin: "https://ai-proxy.zz.gg" },
      ],
    },
    updateChecker: () => updatePromise,
    proxyHealthCheck: async () => ({ state: "online", latencyMs: 1 }),
    actions: { codex: async () => 0, claude: async () => 0 },
  });

  await flushMenu(setup);
  const initial = setup.captureCharFrame();
  assert.match(initial, /user@example\.com/);
  assert.equal(initial.match(/user@example\.com/g)?.length, 1);
  assert.doesNotMatch(initial, /Signed in/);
  assert.doesNotMatch(initial, /Products|verified|Plan|Requests|Tokens|Input|Output|Cached|creation|codex, claude/);
  assert.doesNotMatch(initial, /Updated to/);

  resolveUpdate({ state: "updated", commitDate: "2026-08-13" });
  await flushMenu(setup);
  assert.match(setup.captureCharFrame(), /Updated to Aug 13 version/);

  await setup.mockInput.pressCtrlC();
  await setup.mockInput.pressCtrlC();
  assert.equal(await resultPromise, 130);
});

test("한국어 TUI는 업데이트 완료일을 월일 버전으로 표시한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runStartMenu } = await import("../src/tui/menu.mjs");
  const setup = await createTestRenderer({ width: 100, height: 24 });
  t.after(() => setup.renderer.destroy());
  const resultPromise = runStartMenu({
    rendererFactory: async () => setup,
    language: "ko",
    updateChecker: async () => ({ state: "updated", commitDate: "2026-08-13" }),
    proxyHealthCheck: async () => ({ state: "online", latencyMs: 1 }),
    actions: { login: async () => 0 },
  });

  await flushMenu(setup);
  assert.match(setup.captureCharFrame(), /8월 13일 버전으로 업데이트됨/);

  await setup.mockInput.pressCtrlC();
  await setup.mockInput.pressCtrlC();
  assert.equal(await resultPromise, 130);
});

test("TUI 종료는 아직 확인 중인 자동 업데이트 요청을 취소한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runStartMenu } = await import("../src/tui/menu.mjs");
  const setup = await createTestRenderer({ width: 72, height: 12 });
  t.after(() => setup.renderer.destroy());
  let updateSignal;
  const resultPromise = runStartMenu({
    rendererFactory: async () => setup,
    updateChecker: ({ signal }) => {
      updateSignal = signal;
      return new Promise(() => {});
    },
    proxyHealthCheck: async () => ({ state: "online", latencyMs: 1 }),
    actions: { login: async () => 0 },
  });

  await flushMenu(setup);
  assert.ok(updateSignal instanceof AbortSignal);
  assert.equal(updateSignal.aborted, false);
  await setup.mockInput.pressCtrlC();
  await setup.mockInput.pressCtrlC();
  assert.equal(await resultPromise, 130);
  assert.equal(updateSignal.aborted, true);
});
