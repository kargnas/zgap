import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function tempDir(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zgap-task3-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function flushMenu(setup) {
  await new Promise((resolve) => setTimeout(resolve, 25));
  await setup.renderOnce();
}

function findText(root, content) {
  if (root.plainText === content) return root;
  for (const child of root.getChildren?.() ?? []) {
    const match = findText(child, content);
    if (match) return match;
  }
  return null;
}

test("proxy health는 전체 응답 시간을 반올림한다", async () => {
  const { checkProxyHealth } = await import("../src/tui/menu.mjs");
  const times = [1_000, 1_084.6];
  let request;

  const health = await checkProxyHealth({
    fetchImpl: async (url, options) => {
      request = { url: url.toString(), options };
      return new Response("ok", { status: 200 });
    },
    now: () => times.shift(),
  });

  assert.deepEqual(health, { state: "online", latencyMs: 85 });
  assert.equal(request.url, "https://ai-proxy.zz.gg/health");
  assert.equal(request.options.method, "GET");
  assert.ok(request.options.signal instanceof AbortSignal);
});

test("인자 없는 진입점은 CLI 모듈 import가 끝나기 전에 alternate screen을 연다", async (t) => {
  const root = await tempDir(t);
  const delayedCli = path.join(root, "delayed-cli.mjs");
  const entrypoint = path.join(root, "zgap.mjs");
  await writeFile(delayedCli, 'process.stdout.write("CLI_IMPORT_STARTED\\n"); await new Promise(() => {}); export function main() {}\n');
  const source = (await readFile(path.join(repoDir, "bin", "zgap.mjs"), "utf8"))
    .replace('import("../src/cli.mjs")', `import(${JSON.stringify(delayedCli)})`);
  await writeFile(entrypoint, source, { mode: 0o755 });

  const child = spawn(process.execPath, [entrypoint], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  t.after(() => child.kill("SIGTERM"));
  await new Promise((resolve, reject) => {
    const onData = () => {
      if (stdout.includes("CLI_IMPORT_STARTED")) {
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
  });

  assert.ok(
    stdout.includes("\x1b[?1049h"),
    "alternate-screen escape must be emitted before the delayed CLI import starts",
  );
  child.kill("SIGTERM");
  await once(child, "exit");
});

test("인자 없는 진입점은 초기화 실패 시 원래 screen으로 돌아온다", async (t) => {
  const root = await tempDir(t);
  const failedCli = path.join(root, "failed-cli.mjs");
  const entrypoint = path.join(root, "zgap.mjs");
  await writeFile(failedCli, 'throw new Error("initialization failed");\n');
  const source = (await readFile(path.join(repoDir, "bin", "zgap.mjs"), "utf8"))
    .replace('import("../src/cli.mjs")', `import(${JSON.stringify(failedCli)})`);
  await writeFile(entrypoint, source, { mode: 0o755 });

  const child = spawn(process.execPath, [entrypoint], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "exit");

  assert.equal(code, 1);
  assert.ok(stdout.includes("\x1b[?1049h"));
  assert.ok(stdout.includes("\x1b[?1049l"), "failed initialization must restore the original screen");
  assert.match(stderr, /zgap: initialization failed/);
});

test("proxy health는 non-2xx와 network failure를 unreachable로 반환한다", async () => {
  const { checkProxyHealth } = await import("../src/tui/menu.mjs");

  assert.deepEqual(
    await checkProxyHealth({ fetchImpl: async () => new Response("down", { status: 503 }) }),
    { state: "unreachable" },
  );
  assert.deepEqual(
    await checkProxyHealth({ fetchImpl: async () => { throw new TypeError("offline"); } }),
    { state: "unreachable" },
  );
});

test("TUI는 proxy 확인 중 상태를 먼저 그리고 응답속도로 갱신한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runStartMenu } = await import("../src/tui/menu.mjs");
  const setup = await createTestRenderer({ width: 72, height: 12 });
  t.after(() => setup.renderer.destroy());
  let resolveHealth;
  const health = new Promise((resolve) => { resolveHealth = resolve; });
  const resultPromise = runStartMenu({
    rendererFactory: async () => setup,
    credentialState: "signed-in",
    proxyHealthCheck: () => health,
    actions: { login: async () => 0, codex: async () => 0 },
  });

  await flushMenu(setup);
  assert.match(setup.captureCharFrame(), /Proxy checking/);
  resolveHealth({ state: "online", latencyMs: 85 });
  await flushMenu(setup);
  assert.match(setup.captureCharFrame().replaceAll(/\s+/g, " "), /Proxy online · 85 ms/);
  await setup.mockInput.pressCtrlC();
  await setup.mockInput.pressCtrlC();
  assert.equal(await resultPromise, 130);
});

test("TUI는 proxy ms를 계속 갱신하되 측정을 초당 네 번으로 제한한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runStartMenu } = await import("../src/tui/menu.mjs");
  const setup = await createTestRenderer({ width: 72, height: 12 });
  t.after(() => setup.renderer.destroy());
  const requests = [];
  const resultPromise = runStartMenu({
    rendererFactory: async () => setup,
    credentialState: "signed-in",
    proxyHealthCheck: ({ signal }) => new Promise((resolve) => requests.push({ resolve, signal })),
    actions: { codex: async () => 0, claude: async () => 0 },
  });

  await flushMenu(setup);
  assert.equal(requests.length, 1);
  requests[0].resolve({ state: "online", latencyMs: 85 });
  await flushMenu(setup);
  assert.match(setup.captureCharFrame(), /Proxy online · 85 ms/);
  assert.equal(requests.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(requests.length, 2);
  requests[1].resolve({ state: "online", latencyMs: 23 });
  await flushMenu(setup);
  assert.match(setup.captureCharFrame(), /Proxy online · 23 ms/);
  assert.equal(requests.length, 2);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(requests.length, 3);

  await setup.mockInput.pressCtrlC();
  await setup.mockInput.pressCtrlC();
  assert.equal(await resultPromise, 130);
  assert.equal(requests[2].signal.aborted, true);
});

test("TUI는 proxy 검사 예외와 잘못된 응답을 unreachable로 표시하고 측정을 계속한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runStartMenu } = await import("../src/tui/menu.mjs");
  const setup = await createTestRenderer({ width: 72, height: 12 });
  t.after(() => setup.renderer.destroy());
  let calls = 0;
  let pendingSignal;
  const resultPromise = runStartMenu({
    rendererFactory: async () => setup,
    proxyHealthCheck: ({ signal }) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("probe failed"));
      if (calls === 2) return Promise.resolve(undefined);
      pendingSignal = signal;
      return new Promise(() => {});
    },
    actions: { login: async () => 0 },
  });

  await flushMenu(setup);
  assert.match(setup.captureCharFrame(), /Proxy unreachable/);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(calls, 2);
  assert.match(setup.captureCharFrame(), /Proxy unreachable/);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(calls, 3);
  await setup.mockInput.pressCtrlC();
  await setup.mockInput.pressCtrlC();
  assert.equal(await resultPromise, 130);
  assert.equal(pendingSignal.aborted, true);
});

test("TUI는 proxy 실패를 표시하고 종료할 때 진행 중인 확인을 취소한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runStartMenu } = await import("../src/tui/menu.mjs");
  const failedSetup = await createTestRenderer({ width: 40, height: 10 });
  t.after(() => failedSetup.renderer.destroy());
  const failedResult = runStartMenu({
    rendererFactory: async () => failedSetup,
    proxyHealthCheck: async () => ({ state: "unreachable" }),
    actions: { login: async () => 0, codex: async () => 0 },
  });
  await flushMenu(failedSetup);
  assert.match(failedSetup.captureCharFrame(), /Proxy unreachable/);
  await failedSetup.mockInput.pressCtrlC();
  await failedSetup.mockInput.pressCtrlC();
  assert.equal(await failedResult, 130);

  const pendingSetup = await createTestRenderer({ width: 72, height: 12 });
  t.after(() => pendingSetup.renderer.destroy());
  let requestSignal;
  const pendingResult = runStartMenu({
    rendererFactory: async () => pendingSetup,
    proxyHealthCheck: ({ signal }) => {
      requestSignal = signal;
      return new Promise(() => {});
    },
    actions: { login: async () => 0, codex: async () => 0 },
  });
  await flushMenu(pendingSetup);
  assert.match(pendingSetup.captureCharFrame(), /Proxy checking/);
  await pendingSetup.mockInput.pressCtrlC();
  await pendingSetup.mockInput.pressCtrlC();
  assert.equal(await pendingResult, 130);
  assert.equal(requestSignal.aborted, true);
});

test("Corner Map은 100x24의 네 모서리와 중앙을 사용한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runStartMenu } = await import("../src/tui/menu.mjs");
  const setup = await createTestRenderer({ width: 100, height: 24 });
  t.after(() => setup.renderer.destroy());
  const resultPromise = runStartMenu({
    rendererFactory: async () => setup,
    credentialState: "signed-in",
    accountProfile: { email: "user@example.com" },
    proxyHealthCheck: async () => ({ state: "online", latencyMs: 85 }),
    actions: { login: async () => 0, codex: async () => 0 },
  });
  await flushMenu(setup);

  const title = findText(setup.renderer.root, "zgap");
  const status = findText(setup.renderer.root, "● user@example.com");
  const proxy = findText(setup.renderer.root, "● Proxy online · 85 ms");
  const action = findText(setup.renderer.root, "CODEX  ↵");
  const hint = findText(setup.renderer.root, "Up/Down move  ·  Enter select  ·  Ctrl+C twice or Esc twice quit");
  assert.doesNotMatch(setup.captureCharFrame(), /CHOOSE AN ACTION/);
  assert.ok(title.x <= 3 && title.y <= 3, `title at ${title.x},${title.y}`);
  assert.ok(status.x >= 80 && status.y <= 3, `status at ${status.x},${status.y}`);
  assert.ok(proxy.x >= 75 && proxy.y <= 4, `proxy at ${proxy.x},${proxy.y}`);
  assert.ok(action.x <= 20 && action.y >= 9 && action.y <= 14, `action at ${action.x},${action.y}`);
  assert.ok(hint.x >= 30 && hint.y >= 21, `hint at ${hint.x},${hint.y}`);

  await setup.mockInput.pressCtrlC();
  await setup.mockInput.pressCtrlC();
  assert.equal(await resultPromise, 130);
});

test("Corner Map은 ready marker를 한국어로 표시한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runStartMenu } = await import("../src/tui/menu.mjs");
  const setup = await createTestRenderer({ width: 100, height: 24 });
  t.after(() => setup.renderer.destroy());
  const resultPromise = runStartMenu({
    rendererFactory: async () => setup,
    language: "ko",
    proxyHealthCheck: async () => ({ state: "online", latencyMs: 85 }),
    actions: { login: async () => 0, codex: async () => 0 },
  });
  await flushMenu(setup);

  const ready = findText(setup.renderer.root, "zgap / 준비됨");
  assert.ok(ready && ready.x <= 3 && ready.y >= 21, `ready at ${ready?.x},${ready?.y}`);

  await setup.mockInput.pressCtrlC();
  await setup.mockInput.pressCtrlC();
  assert.equal(await resultPromise, 130);
});

test("인자 없는 CLI는 credential 상태를 시작 메뉴에 전달한다", async () => {
  const { main } = await import("../src/cli.mjs");
  let credentialRequest;
  let menuOptions;

  const result = await main({
    argv: [],
    configDir: "/tmp/zgap-config",
    credentialStateReader: async (options) => {
      credentialRequest = options;
      return "signed-in";
    },
    startMenu: async (options) => {
      menuOptions = options;
      return 23;
    },
    entryPath: "/tmp/zgap",
    invokedPath: "/tmp/zgap",
    modulePath: "/tmp/zgap",
  });

  assert.equal(result, 23);
  assert.deepEqual(credentialRequest, { credentialFile: "/tmp/zgap-config/credentials.json" });
  assert.equal(menuOptions.credentialState, "signed-in");
  assert.equal(typeof menuOptions.actions.login, "function");
  assert.equal(typeof menuOptions.actions.codex, "function");
  assert.equal(typeof menuOptions.actions.claude, "function");
  assert.equal(typeof menuOptions.actions.sessions, "function");
});

test("sessions direct command는 현재 디렉터리의 browser를 연다", async () => {
  const { main } = await import("../src/cli.mjs");
  let options;

  const result = await main({
    argv: ["sessions"],
    cwd: "/repo/worktree",
    sessionBrowser: async (value) => { options = value; return 12; },
  });

  assert.equal(result, 12);
  assert.equal(options.cwd, "/repo/worktree");
});

test("start menu의 Sessions에서 뒤로 오면 start menu를 다시 연다", async () => {
  const { main } = await import("../src/cli.mjs");
  let menuCalls = 0;
  let browserCalls = 0;

  const result = await main({
    argv: [],
    cwd: "/repo",
    credentialStateReader: async () => "signed-in",
    credentialReader: async () => ({ access_token: "invalid" }),
    startMenu: async ({ actions }) => {
      menuCalls += 1;
      if (menuCalls === 1) return actions.sessions();
      return 17;
    },
    sessionBrowser: async ({ cwd }) => {
      browserCalls += 1;
      assert.equal(cwd, "/repo");
      return 0;
    },
  });

  assert.equal(result, 17);
  assert.equal(menuCalls, 2);
  assert.equal(browserCalls, 1);
});

test("start menu의 Sessions가 quit하면 start menu를 다시 열지 않는다", async () => {
  const { main } = await import("../src/cli.mjs");
  let menuCalls = 0;

  const result = await main({
    argv: [],
    credentialStateReader: async () => "signed-in",
    credentialReader: async () => ({ access_token: "invalid" }),
    startMenu: async ({ actions }) => {
      menuCalls += 1;
      return actions.sessions();
    },
    sessionBrowser: async () => 130,
  });

  assert.equal(result, 130);
  assert.equal(menuCalls, 1);
});

test("로그인 상태에서는 Login을 숨기고 CODEX를 실행한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runStartMenu } = await import("../src/tui/menu.mjs");
  const setup = await createTestRenderer({ width: 72, height: 12 });
  t.after(() => setup.renderer.destroy());
  const calls = [];

  const resultPromise = runStartMenu({
    rendererFactory: async () => setup,
    credentialState: "signed-in",
    accountProfile: { email: "user@example.com" },
    actions: {
      login: async () => { calls.push("login"); return 7; },
      codex: async () => { calls.push("codex"); return 8; },
    },
  });
  await flushMenu(setup);
  const initial = setup.captureCharFrame();
  assert.match(initial, /user@example\.com/);
  assert.doesNotMatch(initial, /Signed in/);
  assert.match(initial, /CODEX/);
  assert.doesNotMatch(initial, /Login/);
  assert.match(initial, /(?:Enter|↵) select/);
  await setup.mockInput.pressEnter();
  assert.equal(await resultPromise, 8);
  assert.deepEqual(calls, ["codex"]);
});

test("로그인 상태에서는 CODEX, Claude, Sessions를 선택할 수 있다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runStartMenu } = await import("../src/tui/menu.mjs");
  const setup = await createTestRenderer({ width: 100, height: 24 });
  t.after(() => setup.renderer.destroy());
  const calls = [];
  const resultPromise = runStartMenu({
    rendererFactory: async () => setup,
    credentialState: "signed-in",
    actions: {
      codex: async () => { calls.push("codex"); return 8; },
      claude: async () => { calls.push("claude"); return 9; },
    },
  });

  await flushMenu(setup);
  const frame = setup.captureCharFrame();
  assert.match(frame, /CODEX/);
  assert.match(frame, /Claude/);
  assert.match(frame, /Sessions/);
  assert.doesNotMatch(frame, /Login/);
  const codexLabel = findText(setup.renderer.root, "CODEX  ↵");
  const claudeLabel = findText(setup.renderer.root, "Claude  ↵");
  const sessionsLabel = findText(setup.renderer.root, "Sessions  ↵");
  assert.equal(codexLabel.x, claudeLabel.x);
  assert.equal(claudeLabel.x, sessionsLabel.x);
  assert.ok(claudeLabel.y > codexLabel.y, `Claude action must be below Codex: ${claudeLabel.y} <= ${codexLabel.y}`);
  assert.ok(sessionsLabel.y > claudeLabel.y, `Sessions action must be below Claude: ${sessionsLabel.y} <= ${claudeLabel.y}`);
  assert.notEqual(codexLabel.fg.toString(), claudeLabel.fg.toString());

  await setup.mockInput.pressArrow("down");
  assert.notEqual(codexLabel.fg.toString(), claudeLabel.fg.toString());
  await setup.mockInput.pressArrow("down");
  assert.notEqual(claudeLabel.fg.toString(), sessionsLabel.fg.toString());
  await setup.mockInput.pressEnter();
  await assert.rejects(resultPromise, /Missing menu action: sessions/);
  assert.deepEqual(calls, []);
});

test("Stacked Command Cards는 상하 박스와 선택 테두리를 유지한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runStartMenu } = await import("../src/tui/menu.mjs");
  const wide = await createTestRenderer({ width: 100, height: 24 });
  const compact = await createTestRenderer({ width: 40, height: 10 });
  t.after(() => wide.renderer.destroy());
  t.after(() => compact.renderer.destroy());
  const actions = { codex: async () => 0, claude: async () => 0 };
  const wideResult = runStartMenu({
    rendererFactory: async () => wide,
    credentialState: "signed-in",
    actions,
  });
  const compactResult = runStartMenu({
    rendererFactory: async () => compact,
    credentialState: "signed-in",
    actions,
  });

  await flushMenu(wide);
  await flushMenu(compact);
  const codexCard = findText(wide.renderer.root, "CODEX  ↵").parent;
  const claudeCard = findText(wide.renderer.root, "Claude  ↵").parent;
  assert.equal(codexCard.border, true);
  assert.equal(claudeCard.border, true);
  const selectedBorder = codexCard.borderColor.toString();
  const unselectedBorder = claudeCard.borderColor.toString();
  assert.notEqual(selectedBorder, unselectedBorder);
  assert.match(wide.captureCharFrame(), /╭─+╮/);
  assert.match(compact.captureCharFrame(), /╭─+╮/);
  assert.match(compact.captureCharFrame(), /CODEX/);
  assert.match(compact.captureCharFrame(), /Claude/);
  assert.match(compact.captureCharFrame(), /Sessions/);
  assert.match(compact.captureCharFrame(), /Esc/);

  await wide.mockInput.pressArrow("down");
  assert.equal(codexCard.borderColor.toString(), unselectedBorder);
  assert.equal(claudeCard.borderColor.toString(), selectedBorder);
  await wide.mockInput.pressCtrlC();
  await wide.mockInput.pressCtrlC();
  await compact.mockInput.pressCtrlC();
  await compact.mockInput.pressCtrlC();
  assert.equal(await wideResult, 130);
  assert.equal(await compactResult, 130);
});

test("로그인 상태의 기본 선택은 Codex이고 Up/Down으로 하나씩 이동한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runStartMenu } = await import("../src/tui/menu.mjs");
  const setup = await createTestRenderer({ width: 40, height: 10 });
  t.after(() => setup.renderer.destroy());
  const calls = [];
  const resultPromise = runStartMenu({
    rendererFactory: async () => setup,
    credentialState: "signed-in",
    actions: {
      codex: async () => { calls.push("codex"); return 8; },
      claude: async () => { calls.push("claude"); return 9; },
    },
  });

  await flushMenu(setup);
  assert.match(setup.captureCharFrame(), /CODEX/);
  await setup.mockInput.pressArrow("up");
  await setup.mockInput.pressEnter();
  assert.equal(await resultPromise, 8);
  assert.deepEqual(calls, ["codex"]);
});

test("만료된 로그인 상태에서는 Login again을 기본 선택한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runStartMenu } = await import("../src/tui/menu.mjs");
  const setup = await createTestRenderer({ width: 72, height: 12 });
  t.after(() => setup.renderer.destroy());
  const calls = [];
  const resultPromise = runStartMenu({
    rendererFactory: async () => setup,
    credentialState: "expired",
    actions: {
      login: async () => { calls.push("login"); return 7; },
      sessions: async () => { calls.push("sessions"); return 10; },
      codex: async () => { calls.push("codex"); return 8; },
    },
  });
  await flushMenu(setup);
  const frame = setup.captureCharFrame();
  assert.match(frame, /Session expired/);
  assert.match(frame, /Login again/);
  assert.match(frame, /Sessions/);
  assert.doesNotMatch(frame, /CODEX/);
  await setup.mockInput.pressEnter();
  assert.equal(await resultPromise, 7);
  assert.deepEqual(calls, ["login"]);
});

test("미로그인 상태에서도 Sessions를 실행한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runStartMenu } = await import("../src/tui/menu.mjs");
  const setup = await createTestRenderer({ width: 72, height: 12 });
  t.after(() => setup.renderer.destroy());
  const calls = [];
  const resultPromise = runStartMenu({
    rendererFactory: async () => setup,
    credentialState: "signed-out",
    actions: {
      login: async () => { calls.push("login"); return 7; },
      sessions: async () => { calls.push("sessions"); return 10; },
      codex: async () => { calls.push("codex"); return 8; },
    },
  });
  await flushMenu(setup);
  const frame = setup.captureCharFrame();
  assert.match(frame, /Not signed in/);
  assert.match(frame, /Login/);
  assert.match(frame, /Sessions/);
  assert.doesNotMatch(frame, /CODEX/);
  await setup.mockInput.pressArrow("down");
  await setup.mockInput.pressEnter();
  assert.equal(await resultPromise, 10);
  assert.deepEqual(calls, ["sessions"]);
});

test("현재 credential 상태의 action이 없으면 성공으로 숨기지 않는다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runStartMenu } = await import("../src/tui/menu.mjs");
  const setup = await createTestRenderer({ width: 72, height: 12 });
  t.after(() => setup.renderer.destroy());
  const resultPromise = runStartMenu({
    rendererFactory: async () => setup,
    credentialState: "signed-in",
    actions: { login: async () => 0 },
  });
  await flushMenu(setup);
  await setup.mockInput.pressEnter();

  await assert.rejects(resultPromise, /Missing menu action: codex/);
});

test("Corner Map의 action text는 mouse drag로 선택할 수 있다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runStartMenu } = await import("../src/tui/menu.mjs");
  const setup = await createTestRenderer({ width: 72, height: 12 });
  t.after(() => setup.renderer.destroy());
  const resultPromise = runStartMenu({
    rendererFactory: async () => setup,
    credentialState: "signed-in",
    actions: { login: async () => 0, codex: async () => 0 },
  });
  await flushMenu(setup);
  const actionLabel = findText(setup.renderer.root, "CODEX  ↵");
  await setup.mockMouse.drag(actionLabel.x, actionLabel.y, actionLabel.x + 10, actionLabel.y);

  assert.match(setup.renderer.getSelection()?.getSelectedText() ?? "", /CODEX/);
  await setup.mockInput.pressCtrlC();
  await setup.mockInput.pressCtrlC();
  assert.equal(await resultPromise, 130);
});

test("Corner Map은 40x10으로 줄어도 상태, action, 종료 hint를 유지한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runStartMenu } = await import("../src/tui/menu.mjs");
  const setup = await createTestRenderer({ width: 72, height: 12 });
  t.after(() => setup.renderer.destroy());
  const resultPromise = runStartMenu({
    rendererFactory: async () => setup,
    credentialState: "signed-in",
    accountProfile: { email: "user@example.com" },
    proxyHealthCheck: async () => ({ state: "online", latencyMs: 85 }),
    actions: { login: async () => 0, codex: async () => 0 },
  });
  await flushMenu(setup);
  setup.resize(100, 24);
  await flushMenu(setup);
  const wideFrame = setup.captureCharFrame();
  assert.match(wideFrame, /user@example\.com/);
  assert.match(wideFrame, /CODEX/);
  assert.match(wideFrame, /Claude/);
  assert.match(wideFrame, /Sessions/);
  assert.match(wideFrame, /Esc/);
  setup.resize(60, 10);
  await flushMenu(setup);
  const boundaryFrame = setup.captureCharFrame();
  assert.doesNotMatch(boundaryFrame, /zgap \/ ready/);
  assert.match(boundaryFrame, /↑↓ move · ↵ select · Esc Esc quit/);
  setup.resize(40, 10);
  await flushMenu(setup);
  const frame = setup.captureCharFrame();
  assert.match(frame, /zgap/);
  assert.match(frame, /user@example\.com/);
  assert.match(frame, /Proxy online · 85 ms/);
  assert.match(frame, /CODEX/);
  assert.match(frame, /Claude/);
  assert.match(frame, /Sessions/);
  assert.match(frame, /Esc/);
  assert.deepEqual(Array.from(setup.captureSpans().lines[0].spans[0].bg.buffer), [0, 0, 0, 255]);
  await setup.mockInput.pressCtrlC();
  await setup.mockInput.pressCtrlC();
  assert.equal(await resultPromise, 130);
});

test("지원하지 않는 locale은 English로 fallback한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runStartMenu } = await import("../src/tui/menu.mjs");
  const setup = await createTestRenderer({ width: 40, height: 10 });
  t.after(() => setup.renderer.destroy());
  const resultPromise = runStartMenu({
    rendererFactory: async () => setup,
    credentialState: "signed-in",
    accountProfile: { email: "user@example.com" },
    language: "de-DE",
    actions: { login: async () => 0, codex: async () => 0 },
  });
  await flushMenu(setup);
  const frame = setup.captureCharFrame();
  assert.match(frame, /user@example\.com/);
  assert.doesNotMatch(frame, /Signed in/);
  assert.match(frame, /CODEX/);
  await setup.mockInput.pressCtrlC();
  await setup.mockInput.pressCtrlC();
  assert.equal(await resultPromise, 130);
});

test("OpenTUI menu exits only after two Ctrl+C or two Esc presses within one second", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runStartMenu } = await import("../src/tui/menu.mjs");
  const setup = await createTestRenderer({ width: 72, height: 12 });
  t.after(() => setup.renderer.destroy());
  let now = 0;
  const resultPromise = runStartMenu({
    rendererFactory: async () => setup,
    now: () => now,
    actions: { login: async () => 0, codex: async () => 0 },
  });
  await flushMenu(setup);
  await setup.mockInput.pressCtrlC();
  now = 500;
  await setup.mockInput.pressCtrlC();
  assert.equal(await resultPromise, 130);

  const second = await createTestRenderer({ width: 72, height: 12 });
  t.after(() => second.renderer.destroy());
  now = 0;
  const secondResult = runStartMenu({
    rendererFactory: async () => second,
    now: () => now,
    actions: { login: async () => 0, codex: async () => 0 },
  });
  await flushMenu(second);
  await second.mockInput.pressEscape();
  await new Promise((resolve) => setTimeout(resolve, 100));
  now = 1_001;
  await second.mockInput.pressEscape();
  await new Promise((resolve) => setTimeout(resolve, 100));
  now = 1_002;
  await second.mockInput.pressEscape();
  await new Promise((resolve) => setTimeout(resolve, 100));
  now = 1_500;
  await second.mockInput.pressEscape();
  assert.equal(await secondResult, 130);
});

test("OpenTUI menu destroys renderer on selection and action errors", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runStartMenu } = await import("../src/tui/menu.mjs");
  const setup = await createTestRenderer({ width: 72, height: 12 });
  t.after(() => setup.renderer.destroy());
  let destroyed = 0;
  const originalDestroy = setup.renderer.destroy.bind(setup.renderer);
  setup.renderer.destroy = () => { destroyed += 1; return originalDestroy(); };
  const selected = runStartMenu({
    rendererFactory: async () => setup,
    actions: { login: async () => 0, codex: async () => 0 },
  });
  await flushMenu(setup);
  await setup.mockInput.pressEnter();
  await selected;
  assert.equal(destroyed, 1);

  const broken = await createTestRenderer({ width: 72, height: 12 });
  t.after(() => broken.renderer.destroy());
  let brokenDestroyed = 0;
  const brokenDestroy = broken.renderer.destroy.bind(broken.renderer);
  broken.renderer.destroy = () => { brokenDestroyed += 1; return brokenDestroy(); };
  const failed = runStartMenu({
    rendererFactory: async () => broken,
    actions: { login: async () => { throw new Error("login failed"); }, codex: async () => 0 },
  });
  await flushMenu(broken);
  await broken.mockInput.pressEnter();
  await assert.rejects(failed, /login failed/);
  assert.equal(brokenDestroyed, 1);
});

test("OpenTUI keeps signal cleanup while reserving Ctrl+C for the double-press handler", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runStartMenu } = await import("../src/tui/menu.mjs");
  const setup = await createTestRenderer({ width: 72, height: 12 });
  t.after(() => setup.renderer.destroy());
  let rendererOptions;
  const result = runStartMenu({
    rendererFactory: async (options) => {
      rendererOptions = options;
      return setup;
    },
    actions: { login: async () => 0, codex: async () => 0 },
  });
  await flushMenu(setup);
  await setup.mockInput.pressCtrlC();
  await setup.mockInput.pressCtrlC();
  assert.equal(await result, 130);
  assert.deepEqual(rendererOptions.exitSignals, [
    "SIGTERM",
    "SIGQUIT",
    "SIGABRT",
    "SIGHUP",
    "SIGBREAK",
    "SIGPIPE",
    "SIGBUS",
  ]);
  assert.equal(rendererOptions.exitOnCtrlC, false);
  assert.equal(rendererOptions.backgroundColor, "#000000");
});

test("CLI help는 logout direct command를 안내한다", async () => {
  const child = spawn(process.execPath, [path.join(repoDir, "bin", "zgap.mjs"), "--help"]);
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.match(stdout, /zgap logout\s+Sign out on this device/);
  assert.match(stdout, /zgap sessions\s+Browse Codex and Claude history/);
  assert.match(stdout, /zgap update\s+Update zgap from GitHub main/);
});

test("global update reinstalls the GitHub main branch without cached resolution", async () => {
  const { updateGlobalInstall } = await import("../src/install.mjs");
  const calls = [];
  const result = await updateGlobalInstall({
    run: async (...args) => { calls.push(args); return 0; },
  });
  assert.equal(result, 0);
  assert.deepEqual(calls, [["bun", ["add", "-g", "github:kargnas/zgap#main", "--force", "--no-cache"]]]);
});

test("Bun package dry-run contains runtime files only", async () => {
  const child = spawn(process.execPath, ["pm", "pack", "--dry-run", "--ignore-scripts"], { cwd: repoDir });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "exit");
  const output = `${stdout}\n${stderr}`;
  assert.equal(code, 0, output);
  const packedLines = output.split(/\r?\n/).filter((line) => line.startsWith("packed "));
  for (const file of [
    "bin/zgap.mjs",
    "install.sh",
    "src/cli.mjs",
    "src/sessions.mjs",
    "src/tui/menu.mjs",
    "src/tui/session-browser.mjs",
    "src/tui/locales/en.json",
  ]) {
    assert.ok(packedLines.some((line) => line.endsWith(` ${file}`)), `missing packed file: ${file}`);
  }
  for (const excluded of [".agents/", "test/", "AGENTS.md", "VERIFICATION_REPORT.md", "skills-lock.json", "untitled.md"]) {
    assert.equal(packedLines.some((line) => line.endsWith(` ${excluded}`) || line.includes(` ${excluded}`)), false, `unexpected packed file: ${excluded}`);
  }
});

test("installer uses existing Bun and never manages zgap files", async (t) => {
  const root = await tempDir(t);
  const fakeBin = path.join(root, "bin");
  const marker = path.join(root, "bun-args");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(path.join(fakeBin, "bun"), `#!/bin/sh
printf '%s\\n' "$@" > ${marker}
`);
  await chmod(path.join(fakeBin, "bun"), 0o755);
  const child = spawn("/bin/bash", [path.join(repoDir, "install.sh")], {
    env: { PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.equal(await readFile(marker, "utf8"), "add\n-g\ngithub:kargnas/zgap#main\n--force\n--no-cache\n");
  assert.equal((await readdir(root)).includes("zgap"), false);
});

test("installer installs Bun through the official curl command when Bun is absent", async (t) => {
  const root = await tempDir(t);
  const fakeBin = path.join(root, "bin");
  const bunInstall = path.join(root, "bun-install");
  const curlArgs = path.join(root, "curl-args");
  const bunArgs = path.join(root, "bun-args");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(path.join(fakeBin, "curl"), `#!/bin/sh
printf '%s\\n' "$@" > ${curlArgs}
mkdir -p ${bunInstall}/bin
printf '#!/bin/sh\\nprintf "%%s\\n" "$@" > ${bunArgs}\\n' > ${bunInstall}/bin/bun
chmod +x ${bunInstall}/bin/bun
`);
  await chmod(path.join(fakeBin, "curl"), 0o755);
  const child = spawn("/bin/bash", [path.join(repoDir, "install.sh")], {
    env: { PATH: `${fakeBin}:/bin:/usr/bin`, BUN_INSTALL: bunInstall },
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.equal(await readFile(curlArgs, "utf8"), "-fsSL\nhttps://bun.com/install\n");
  assert.equal(await readFile(bunArgs, "utf8"), "add\n-g\ngithub:kargnas/zgap#main\n--force\n--no-cache\n");
});
