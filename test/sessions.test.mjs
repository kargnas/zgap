import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const sessions = await import("../src/sessions.mjs");

test("session title normalizes whitespace and prioritizes title, prompt, then id", () => {
  assert.equal(sessions.formatSessionTitle("  hello\n  world  "), "hello world");
  assert.equal(sessions.formatSessionTitle("\u001b]0;INJECT\u0007title\u0085"), "title");
  assert.equal(sessions.formatSessionTitle("before\u001b\\after"), "beforeafter");
  assert.equal(sessions.formatSessionTitle("before\u001cafter"), "before after");
  assert.equal(sessions.formatSessionTitle(""), "");
  assert.equal(sessions.formatSessionTitle("x".repeat(200)).length, 120);
});

test("session title normalization stays fast for a large session index", () => {
  const startedAt = performance.now();
  for (let index = 0; index < 3_000; index += 1) {
    sessions.formatSessionTitle(`\u001b[31mSession ${index}\u001b[0m\u001c`);
  }
  assert.ok(performance.now() - startedAt < 1_000);
});

test("Claude ai title과 first prompt를 모두 정규화한다", async () => {
  const result = await sessions.listSessions({
    cwd: "/repo",
    repositoryRoots: ["/repo"],
    readCodex: async () => [],
    readClaude: async () => [
      { sessionId: "title", projectPath: "/repo", aiTitle: "\u001b[31mAI title\u001b[0m" },
      { sessionId: "prompt", projectPath: "/repo", firstPrompt: "\u001b]0;prompt\u0007First command" },
    ],
  });
  assert.deepEqual(result.map(({ id, title }) => ({ id, title })), [
    { id: "prompt", title: "First command" },
    { id: "title", title: "AI title" },
  ]);
});

test("filterSessions filters agent and provider while retaining all by default", () => {
  const values = [
    { agent: "codex", provider: "openai", id: "1", cwd: "/repo", title: "one", updatedAt: 2 },
    { agent: "claude", provider: null, id: "2", cwd: "/repo", title: "two", updatedAt: 1 },
  ];
  assert.deepEqual(sessions.filterSessions(values, {}), values);
  assert.deepEqual(sessions.filterSessions(values, { agent: "claude" }), [values[1]]);
  assert.deepEqual(sessions.filterSessions(values, { provider: "openai" }), [values[0]]);
});

test("listSessions reads Codex sqlite and Claude index records", async (t) => {
  const root = "/fixture/repo";
  const result = await sessions.listSessions({
    cwd: root,
    codexHome: "/missing",
    claudeHome: "/missing",
    repositoryRoots: [root],
    readCodex: async () => [{ id: "c1", model_provider: "agp", cwd: root, title: "  Codex  title ", updated_at: 10 }],
    readClaude: async () => [{ sessionId: "a1", projectPath: root, firstPrompt: " first\n command ", modified: "2026-01-01T00:00:00Z" }],
  });
  assert.deepEqual(result, [
    { agent: "claude", provider: null, id: "a1", cwd: root, title: "first command", preview: { turns: [] }, updatedAt: Date.parse("2026-01-01T00:00:00Z") },
    { agent: "codex", provider: "agp", id: "c1", cwd: root, title: "Codex title", preview: { turns: [] }, updatedAt: 10 },
  ]);
});

test("listSessions는 열린 JSONL과 일치하는 세션만 실행 중으로 표시한다", async () => {
  const activePath = "/sessions/active.jsonl";
  const result = await sessions.listSessions({
    cwd: "/repo",
    repositoryRoots: ["/repo"],
    readCodex: async () => [
      { id: "active", model_provider: "zgap", cwd: "/repo", title: "Active", previewPath: activePath, updated_at: 2 },
      { id: "idle", model_provider: "openai", cwd: "/repo", title: "Idle", previewPath: "/sessions/idle.jsonl", updated_at: 1 },
    ],
    readClaude: async () => [],
    readActiveSessionPaths: async () => new Set([activePath]),
  });

  assert.equal(result.find(({ id }) => id === "active").active, true);
  assert.equal(result.find(({ id }) => id === "idle").active, undefined);
});

test("readActiveSessionPaths는 일부 command가 없어 lsof가 1을 반환해도 열린 JSONL을 보존한다", async () => {
  const activePath = path.resolve("/sessions/active.jsonl");
  const error = Object.assign(new Error("lsof exited with code 1"), {
    stdout: `p123\nn${activePath}\n`,
  });

  const result = await sessions.readActiveSessionPaths(async () => { throw error; });

  assert.deepEqual([...result], [activePath]);
});

test("No prompt title은 첫 사용자 명령으로 대체한다", async () => {
  const result = await sessions.listSessions({
    cwd: "/repo",
    repositoryRoots: ["/repo"],
    readCodex: async () => [{
      id: "codex",
      cwd: "/repo",
      model_provider: "openai",
      title: "No prompt",
      first_user_message: "actual first command",
    }],
    readClaude: async () => [],
  });
  assert.equal(result[0]?.title, "actual first command");
});

test("listSessions는 소스가 끝날 때마다 onUpdate로 부분 결과를 전달한다", async () => {
  const updates = [];
  let releaseClaude;
  const claudeGate = new Promise((resolve) => { releaseClaude = resolve; });
  const result = await sessions.listSessions({
    cwd: "/repo",
    all: true,
    readCodex: async () => [{ id: "c1", model_provider: "agp", cwd: "/repo", title: "codex", updated_at: 10 }],
    readClaude: async () => {
      await claudeGate;
      return [{ sessionId: "a1", projectPath: "/repo", firstPrompt: "claude", modified: 20 }];
    },
    onUpdate: (partial) => {
      updates.push(partial.map(({ id }) => id));
      releaseClaude();
    },
  });
  assert.deepEqual(updates[0], ["c1"]);
  assert.deepEqual(result.map(({ id }) => id), ["a1", "c1"]);
  assert.deepEqual(updates.at(-1), ["a1", "c1"]);
});

test("malformed records are isolated and repository containment is segment-safe", async () => {
  const values = await sessions.listSessions({
    cwd: "/repo",
    all: false,
    repositoryRoots: ["/repo"],
    readCodex: async () => [null, { id: "inside", cwd: "/repo/sub", model_provider: "x", updated_at: 1 }, { id: "outside", cwd: "/repo-other", model_provider: "x", updated_at: 2 }],
    readClaude: async () => { throw new Error("bad source"); },
  });
  assert.deepEqual(values.map(({ id }) => id), ["inside"]);
});

test("Codex fallback recursively aggregates one nested JSONL session", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "zgap-codex-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const nested = path.join(home, "sessions", "2026", "08", "14");
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(nested, "one.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "nested", cwd: "/repo", model_provider: "agp", timestamp: "2026-08-14T00:00:00Z" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "first command" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "second command" }] } }),
  ].join("\n"));
  const result = await sessions.listSessions({ codexHome: home, claudeHome: "/missing", all: true });
  const session = result.find(({ id }) => id === "nested");
  assert.deepEqual(session, {
    agent: "codex", provider: "agp", id: "nested", cwd: "/repo", title: "first command",
    preview: { turns: [] }, previewLocator: { type: "jsonl", path: path.join(nested, "one.jsonl") },
    updatedAt: Date.parse("2026-08-14T00:00:00Z"),
  });
  assert.deepEqual(await sessions.loadSessionPreview(session), {
    turns: [{ user: "second command", assistant: null }],
  });
});

test("Claude JSONL ai-title wins over first user prompt and excludes subagents", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "zgap-claude-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = path.join(home, "projects", "-repo");
  await mkdir(path.join(project, "subagents"), { recursive: true });
  await writeFile(path.join(project, "main.jsonl"), [
    JSON.stringify({ cwd: "/repo", type: "user", message: { role: "user", content: "first prompt" }, timestamp: "2026-08-14T00:00:00Z" }),
    JSON.stringify({ type: "custom-title", title: "AI title" }),
  ].join("\n"));
  await writeFile(path.join(project, "subagents", "child.jsonl"), JSON.stringify({ cwd: "/repo", type: "user", message: { role: "user", content: "hidden" } }));
  const result = await sessions.listSessions({ codexHome: "/missing", claudeHome: home, all: true });
  const session = result.find(({ id }) => id === "main");
  assert.deepEqual(session, {
    agent: "claude", provider: null, id: "main", cwd: "/repo", title: "AI title", preview: {
      turns: [],
    }, previewLocator: { type: "jsonl", path: path.join(project, "main.jsonl") }, updatedAt: Date.parse("2026-08-14T00:00:00Z"),
  });
  assert.equal(result.some(({ title }) => title === "hidden"), false);
});

test("Claude JSONL은 local command metadata를 건너뛰고 첫 사용자 명령을 표시한다", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "zgap-claude-command-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = path.join(home, "projects", "-repo");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "main.jsonl"), [
    JSON.stringify({ cwd: "/repo", type: "user", message: { role: "user", content: "<local-command-caveat>generated metadata</local-command-caveat>" } }),
    JSON.stringify({ cwd: "/repo", type: "user", message: { role: "user", content: "<command-name>/model</command-name>" } }),
    JSON.stringify({ cwd: "/repo", type: "user", message: { role: "user", content: [{ type: "tool_result", content: "tool output" }] } }),
    JSON.stringify({ cwd: "/repo", type: "user", message: { role: "user", content: "real command" } }),
  ].join("\n"));

  const result = await sessions.listSessions({ codexHome: "/missing", claudeHome: home, all: true });
  assert.equal(result.find(({ id }) => id === "main")?.title, "real command");
});

test("repo scope reads Claude project directory encoded from a related worktree root", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "zgap-claude-scope-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = "/Users/example/projects/zgap";
  const project = path.join(home, "projects", "-Users-example-projects-zgap");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "one.jsonl"), [
    JSON.stringify({ type: "attachment", sessionId: "one", cwd: root, timestamp: "2026-08-14T00:00:00Z" }),
    JSON.stringify({ type: "user", sessionId: "one", cwd: root, message: { role: "user", content: "scoped prompt" }, timestamp: "2026-08-14T00:00:01Z" }),
  ].join("\n"));

  const result = await sessions.listSessions({
    cwd: "/Users/example/worktrees/zgap/feature",
    codexHome: "/missing",
    claudeHome: home,
    repositoryRoots: [root, "/Users/example/worktrees/zgap/feature"],
  });

  assert.deepEqual(result, [{
    agent: "claude",
    provider: null,
    id: "one",
    cwd: root,
    title: "scoped prompt",
    preview: { turns: [] }, previewLocator: { type: "jsonl", path: path.join(project, "one.jsonl") },
    updatedAt: Date.parse("2026-08-14T00:00:01Z"),
  }]);
});

test("JSONL preview keeps completed user/assistant turns and drops an unanswered tail", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "zgap-preview-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const nested = path.join(home, "sessions", "2026");
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(nested, "conversation.jsonl"), [
    { type: "session_meta", payload: { id: "conversation", cwd: "/repo", model_provider: "agp" } },
    { type: "response_item", payload: { type: "message", role: "system", content: [{ type: "output_text", text: "ignore" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "injected instructions" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "first user" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "first answer" }] } },
    { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "output_text", text: "ignore" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "latest user" }] } },
    { type: "response_item", payload: { type: "function_call", name: "tool", arguments: "{}" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "latest answer" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "unanswered tail" }] } },
  ].map((event) => JSON.stringify(event)).join("\n"));
  const result = await sessions.listSessions({ codexHome: home, claudeHome: "/missing", all: true });
  assert.deepEqual(await sessions.loadSessionPreview(result.find(({ id }) => id === "conversation")), {
    turns: [
      { user: "first user", assistant: "first answer" },
      { user: "latest user", assistant: "latest answer" },
    ],
  });
});

test("Claude JSONL preview skips command metadata and tool-only events", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "zgap-claude-preview-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = path.join(home, "projects", "-repo");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "conversation.jsonl"), [
    { type: "user", sessionId: "conversation", cwd: "/repo", message: { role: "user", content: "<command-name>/model</command-name>" } },
    { type: "user", sessionId: "conversation", cwd: "/repo", message: { role: "user", content: "real question" } },
    { type: "assistant", sessionId: "conversation", cwd: "/repo", message: { role: "assistant", content: [{ type: "text", text: "real answer" }] } },
    { type: "assistant", sessionId: "conversation", cwd: "/repo", message: { role: "assistant", content: [{ type: "tool_use", name: "Read" }] } },
  ].map((event) => JSON.stringify(event)).join("\n"));
  const result = await sessions.listSessions({ codexHome: "/missing", claudeHome: home, all: true });
  assert.deepEqual(await sessions.loadSessionPreview(result.find(({ id }) => id === "conversation")), {
    turns: [{ user: "real question", assistant: "real answer" }],
  });
});

test("Codex SQLite lists metadata without scanning JSONL and loads preview on demand", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "zgap-codex-sqlite-preview-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { Database } = await import("bun:sqlite");
  const db = new Database(path.join(home, "state_5.sqlite"));
  db.run("CREATE TABLE threads (id TEXT, model_provider TEXT, cwd TEXT, title TEXT, first_user_message TEXT, preview TEXT, rollout_path TEXT, updated_at TEXT, updated_at_ms INTEGER)");
  const rolloutPath = path.join(home, "sessions", "2026", "08", "sqlite-session.jsonl");
  db.run("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", ["sqlite-session", "agp", "/repo", "SQLite title", "SQLite prompt", "SQLite preview", rolloutPath, "2026-08-14T00:00:00Z", 100]);
  db.close();

  const nested = path.join(home, "sessions", "2026", "08");
  const archived = path.join(home, "archived_sessions", "2026");
  await mkdir(nested, { recursive: true });
  await mkdir(archived, { recursive: true });
  await writeFile(path.join(nested, "sqlite-session.jsonl"), [
    { type: "session_meta", payload: { id: "sqlite-session", cwd: "/repo", model_provider: "agp" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "JSONL question" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "JSONL answer" }] } },
  ].map((event) => JSON.stringify(event)).join("\n"));
  await writeFile(path.join(archived, "archived-session.jsonl"), [
    { type: "session_meta", payload: { id: "archived-session", cwd: "/repo", model_provider: "agp" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Archived question" }] } },
  ].map((event) => JSON.stringify(event)).join("\n"));

  const result = await sessions.listSessions({ codexHome: home, claudeHome: "/missing", all: true });
  const sqliteSession = result.find(({ id }) => id === "sqlite-session");
  assert.deepEqual(sqliteSession, {
    agent: "codex", provider: "agp", id: "sqlite-session", cwd: "/repo", title: "SQLite title",
    preview: { turns: [] }, previewLocator: { type: "jsonl", path: rolloutPath },
    updatedAt: 100,
  });
  assert.deepEqual(await sessions.loadSessionPreview(sqliteSession), {
    turns: [{ user: "JSONL question", assistant: "JSONL answer" }],
  });
  assert.equal(result.some(({ id }) => id === "archived-session"), false);
});

test("Codex provider conversion updates only selected SQLite rows", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "zgap-codex-provider-convert-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { Database } = await import("bun:sqlite");
  const databasePath = path.join(home, "state_5.sqlite");
  const db = new Database(databasePath);
  db.run("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT)");
  db.run("INSERT INTO threads VALUES (?, ?)", ["one", "zgap"]);
  db.run("INSERT INTO threads VALUES (?, ?)", ["two", "zgap"]);
  db.run("INSERT INTO threads VALUES (?, ?)", ["other", "openai"]);
  db.close();

  const count = await sessions.convertCodexSessionProviders([
    { agent: "codex", id: "one", provider: "zgap" },
    { agent: "codex", id: "two", provider: "zgap" },
  ], "openai", { codexHome: home });

  const verified = new Database(databasePath, { readonly: true });
  t.after(() => verified.close());
  assert.equal(count, 2);
  assert.deepEqual(verified.query("SELECT id, model_provider FROM threads ORDER BY id").all(), [
    { id: "one", model_provider: "openai" },
    { id: "other", model_provider: "openai" },
    { id: "two", model_provider: "openai" },
  ]);
});

test("Codex provider conversion rolls back every row when one session is stale", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "zgap-codex-provider-rollback-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { Database } = await import("bun:sqlite");
  const databasePath = path.join(home, "state_5.sqlite");
  const db = new Database(databasePath);
  db.run("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT)");
  db.run("INSERT INTO threads VALUES (?, ?)", ["current", "zgap"]);
  db.close();

  await assert.rejects(() => sessions.convertCodexSessionProviders([
    { agent: "codex", id: "current", provider: "zgap" },
    { agent: "codex", id: "stale", provider: "zgap" },
  ], "openai", { codexHome: home }), /Session provider changed before conversion: stale/);

  const verified = new Database(databasePath, { readonly: true });
  t.after(() => verified.close());
  assert.equal(verified.query("SELECT model_provider FROM threads WHERE id = ?").get("current").model_provider, "zgap");
});

test("lazy preview finds the last turn before a large trailing event", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "zgap-large-preview-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const rolloutPath = path.join(home, "conversation.jsonl");
  await writeFile(rolloutPath, [
    { type: "session_meta", payload: { id: "large", cwd: "/repo", model_provider: "agp" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "first question" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "first answer" }] } },
    { type: "response_item", payload: { type: "function_call_output", output: "x".repeat(1_200_000) } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "last question" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "last answer" }] } },
    { type: "response_item", payload: { type: "function_call_output", output: "x".repeat(1_200_000) } },
  ].map((event) => JSON.stringify(event)).join("\n"));

  assert.deepEqual(await sessions.loadSessionPreview({
    agent: "codex",
    preview: { turns: [] },
    previewLocator: { type: "jsonl", path: rolloutPath },
  }), {
    turns: [
      { user: "first question", assistant: "first answer" },
      { user: "last question", assistant: "last answer" },
    ],
  });
});

test("lazy preview keeps every completed user/assistant turn in order", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "zgap-all-turns-preview-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const rolloutPath = path.join(home, "conversation.jsonl");
  await writeFile(rolloutPath, [
    { type: "session_meta", payload: { id: "all-turns", cwd: "/repo", model_provider: "agp" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "question one" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "intermediate one" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer one" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "question two" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer two" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "question three" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer three" }] } },
  ].map((event) => JSON.stringify(event)).join("\n"));

  assert.deepEqual(await sessions.loadSessionPreview({
    agent: "codex",
    preview: { turns: [] },
    previewLocator: { type: "jsonl", path: rolloutPath },
  }), {
    turns: [
      { user: "question one", assistant: "answer one" },
      { user: "question two", assistant: "answer two" },
      { user: "question three", assistant: "answer three" },
    ],
  });
});

test("lazy preview excludes injected Codex context from user turns", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "zgap-injected-preview-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const rolloutPath = path.join(home, "conversation.jsonl");
  await writeFile(rolloutPath, [
    { type: "session_meta", payload: { id: "injected", cwd: "/repo", model_provider: "agp" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>hidden</INSTRUCTIONS>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<skill>\n<name>brainstorming</name>\n<path>/hidden/SKILL.md</path>\n</skill>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "design request" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<skill>\n<name>brainstorming</name>\n<path>/hidden/SKILL.md</path>\n</skill>" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "design answer" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "actual question" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "actual answer" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<skill>\n<name>brainstorming</name>\n<path>/hidden/SKILL.md</path>\n</skill>" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "skill answer" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<codex_internal_context source=\"goal\">hidden</codex_internal_context>" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "internal answer" }] } },
  ].map((event) => JSON.stringify(event)).join("\n"));

  assert.deepEqual(await sessions.loadSessionPreview({
    agent: "codex",
    preview: { turns: [] },
    previewLocator: { type: "jsonl", path: rolloutPath },
  }), {
    turns: [
      { user: "design request", assistant: "design answer" },
      { user: "actual question", assistant: "actual answer" },
    ],
  });
});

test("session details reports completed turns and exact JSONL byte size", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "zgap-session-details-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const rolloutPath = path.join(home, "conversation.jsonl");
  const contents = [
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "first question" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "first answer" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<codex_internal_context>hidden</codex_internal_context>" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hidden answer" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "last question" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "last answer" }] } },
  ].map((event) => JSON.stringify(event)).join("\n");
  await writeFile(rolloutPath, contents);

  assert.deepEqual(await sessions.loadSessionDetails({
    preview: { turns: [] },
    previewLocator: { type: "jsonl", path: rolloutPath },
  }), {
    turnCount: 2,
    fileSize: Buffer.byteLength(contents),
    preview: {
      turns: [
        { user: "first question", assistant: "first answer" },
        { user: "last question", assistant: "last answer" },
      ],
    },
  });
});
