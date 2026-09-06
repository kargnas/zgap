import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "./harness.mjs";

function lockfileContent(commit) {
  return JSON.stringify({
    workspaces: { "": { dependencies: { zgap: "github:kargnas/zgap#main" } } },
    packages: { zgap: [`zgap@github:kargnas/zgap#${commit}`] },
  });
}

async function installedFixture(t, commit) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zgap-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "node_modules", "zgap");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(root, "bun.lock"), lockfileContent(commit));
  return { root, packageRoot, configDir: path.join(root, "config") };
}

function remoteResponse(sha, headers) {
  return new Response(JSON.stringify({ sha, commit: { author: { date: "2026-08-13T00:00:00Z" } } }), { status: 200, headers });
}

test("source checkout is skipped even when an update is available", async (t) => {
  const { checkForGlobalUpdate } = await import("../src/install.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "zgap-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await checkForGlobalUpdate({
    packageRoot: root,
    globalRoot: path.join(root, "global"),
    fetcher: async () => { throw new Error("must not fetch"); },
  });
  assert.deepEqual(result, { state: "skipped" });
});

test("linked development install is skipped before network access", async (t) => {
  const { checkForGlobalUpdate } = await import("../src/install.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "zgap-linked-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const globalRoot = path.join(root, "global");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(path.join(globalRoot, "node_modules"), { recursive: true });
  await symlink(sourceRoot, path.join(globalRoot, "node_modules", "zgap"));

  const result = await checkForGlobalUpdate({
    packageRoot: sourceRoot,
    globalRoot,
    fetcher: async () => { throw new Error("must not fetch"); },
  });

  assert.deepEqual(result, { state: "skipped" });
});

test("non-Bun global install is skipped before network access", async (t) => {
  const { checkForGlobalUpdate } = await import("../src/install.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "zgap-non-bun-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "node_modules", "zgap");
  await mkdir(packageRoot, { recursive: true });

  const result = await checkForGlobalUpdate({
    packageRoot,
    fetcher: async () => { throw new Error("must not fetch"); },
  });

  assert.deepEqual(result, { state: "skipped" });
});

test("matching GitHub main commit returns current with its commit date", async (t) => {
  const commit = "a".repeat(40);
  const { root, packageRoot, configDir } = await installedFixture(t, commit);
  const { checkForGlobalUpdate } = await import("../src/install.mjs");
  const result = await checkForGlobalUpdate({
    packageRoot,
    globalRoot: root,
    configDir,
    fetcher: async (_url, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(JSON.stringify({
        sha: commit,
        commit: { author: { date: "2026-08-13T00:00:00Z" } },
      }), { status: 200 });
    },
  });
  assert.deepEqual(result, { state: "current", commitDate: "2026-08-13" });
});

test("custom Bun global root is derived from the running package path", async (t) => {
  const commit = "a".repeat(40);
  const { packageRoot, configDir } = await installedFixture(t, commit);
  const { checkForGlobalUpdate } = await import("../src/install.mjs");
  const result = await checkForGlobalUpdate({
    packageRoot,
    configDir,
    fetcher: async () => new Response(JSON.stringify({
      sha: commit,
      commit: { author: { date: "2026-08-13T00:00:00Z" } },
    }), { status: 200 }),
  });

  assert.deepEqual(result, { state: "current", commitDate: "2026-08-13" });
});

test("different GitHub main commit reinstalls and returns updated", async (t) => {
  const installed = "a".repeat(40);
  const remote = "b".repeat(40);
  const { root, packageRoot, configDir } = await installedFixture(t, installed);
  const { checkForGlobalUpdate } = await import("../src/install.mjs");
  const calls = [];
  const result = await checkForGlobalUpdate({
    packageRoot,
    globalRoot: root,
    configDir,
    fetcher: async () => new Response(JSON.stringify({
      sha: remote,
      commit: { author: { date: "2026-08-13T00:00:00Z" } },
    }), { status: 200 }),
    run: async (...args) => {
      calls.push(args);
      await writeFile(path.join(root, "bun.lock"), lockfileContent(remote));
      return 0;
    },
  });
  assert.deepEqual(result, { state: "updated", commitDate: "2026-08-13" });
  assert.deepEqual(calls, [["bun", ["update", "-g", "zgap", "--force", "--no-cache"]]]);
});

test("reinstall that keeps the previous lockfile pin never reports updated", async (t) => {
  const installed = "a".repeat(40);
  const remote = "b".repeat(40);
  const { root, packageRoot, configDir } = await installedFixture(t, installed);
  const { checkForGlobalUpdate } = await import("../src/install.mjs");
  const result = await checkForGlobalUpdate({
    packageRoot,
    globalRoot: root,
    configDir,
    fetcher: async () => new Response(JSON.stringify({
      sha: remote,
      commit: { author: { date: "2026-08-13T00:00:00Z" } },
    }), { status: 200 }),
    // Bun exits 0 while silently reusing the pinned commit; the checker must treat that as failure.
    run: async () => 0,
  });
  assert.deepEqual(result, { state: "error" });
});

test("update errors become a non-throwing error result", async (t) => {
  const commit = "a".repeat(40);
  const { root, packageRoot, configDir } = await installedFixture(t, commit);
  const { checkForGlobalUpdate } = await import("../src/install.mjs");
  const result = await checkForGlobalUpdate({
    packageRoot,
    globalRoot: root,
    configDir,
    fetcher: async () => { throw new Error("offline"); },
  });
  assert.deepEqual(result, { state: "error" });
});

test("invalid GitHub commit metadata never starts an update", async (t) => {
  const commit = "a".repeat(40);
  const { root, packageRoot, configDir } = await installedFixture(t, commit);
  const { checkForGlobalUpdate } = await import("../src/install.mjs");
  let updateCalls = 0;
  const result = await checkForGlobalUpdate({
    packageRoot,
    globalRoot: root,
    configDir,
    fetcher: async () => new Response(JSON.stringify({
      sha: "not-a-commit",
      commit: { author: { date: "2026-08-13T00:00:00Z" } },
    }), { status: 200 }),
    run: async () => { updateCalls += 1; return 0; },
  });

  assert.deepEqual(result, { state: "error" });
  assert.equal(updateCalls, 0);
});

test("automatic reinstall uses silent child stdio", async (t) => {
  const installed = "a".repeat(40);
  const remote = "b".repeat(40);
  const { root, packageRoot, configDir } = await installedFixture(t, installed);
  const { checkForGlobalUpdate } = await import("../src/install.mjs");
  const result = await checkForGlobalUpdate({
    packageRoot,
    globalRoot: root,
    configDir,
    fetcher: async () => new Response(JSON.stringify({
      sha: remote,
      commit: { author: { date: "2026-08-13T00:00:00Z" } },
    }), { status: 200 }),
    run: async (command, args) => {
      assert.equal(command, "bun");
      assert.deepEqual(args, ["update", "-g", "zgap", "--force", "--no-cache"]);
      await writeFile(path.join(root, "bun.lock"), lockfileContent(remote));
      return 0;
    },
  });
  assert.deepEqual(result, { state: "updated", commitDate: "2026-08-13" });
});

test("a fetched main head is cached with its ETag and reused within the hour", async (t) => {
  const commit = "a".repeat(40);
  const { root, packageRoot, configDir } = await installedFixture(t, commit);
  const { checkForGlobalUpdate, remoteHeadCachePath } = await import("../src/install.mjs");
  let fetches = 0;
  const check = () => checkForGlobalUpdate({
    packageRoot,
    globalRoot: root,
    configDir,
    fetcher: async () => { fetches += 1; return remoteResponse(commit, { etag: 'W/"head-1"' }); },
  });

  assert.deepEqual(await check(), { state: "current", commitDate: "2026-08-13" });
  const cached = JSON.parse(await readFile(remoteHeadCachePath(configDir), "utf8"));
  assert.equal(cached.sha, commit);
  assert.equal(cached.etag, 'W/"head-1"');
  assert.ok(Date.now() - cached.checkedAt < 60_000);

  assert.deepEqual(await check(), { state: "current", commitDate: "2026-08-13" });
  assert.equal(fetches, 1);
});

test("a stale cache sends If-None-Match and a 304 reuses the cached head", async (t) => {
  const commit = "a".repeat(40);
  const { root, packageRoot, configDir } = await installedFixture(t, commit);
  const { checkForGlobalUpdate, remoteHeadCachePath } = await import("../src/install.mjs");
  await mkdir(configDir, { recursive: true });
  const staleCheckedAt = Date.now() - 2 * 60 * 60_000;
  await writeFile(remoteHeadCachePath(configDir), JSON.stringify({ sha: commit, commitDate: "2026-08-13", etag: 'W/"head-1"', checkedAt: staleCheckedAt }));
  let requestHeaders;

  const result = await checkForGlobalUpdate({
    packageRoot,
    globalRoot: root,
    configDir,
    fetcher: async (_url, options) => {
      requestHeaders = options.headers;
      return new Response(null, { status: 304 });
    },
  });

  assert.deepEqual(result, { state: "current", commitDate: "2026-08-13" });
  assert.equal(requestHeaders["if-none-match"], 'W/"head-1"');
  const cached = JSON.parse(await readFile(remoteHeadCachePath(configDir), "utf8"));
  assert.equal(cached.sha, commit);
  assert.ok(cached.checkedAt > staleCheckedAt);
});

test("a cached newer head within the hour reinstalls without fetching", async (t) => {
  const installed = "a".repeat(40);
  const remote = "b".repeat(40);
  const { root, packageRoot, configDir } = await installedFixture(t, installed);
  const { checkForGlobalUpdate, remoteHeadCachePath } = await import("../src/install.mjs");
  await mkdir(configDir, { recursive: true });
  await writeFile(remoteHeadCachePath(configDir), JSON.stringify({ sha: remote, commitDate: "2026-08-13", checkedAt: Date.now() }));

  const result = await checkForGlobalUpdate({
    packageRoot,
    globalRoot: root,
    configDir,
    fetcher: async () => { throw new Error("must not fetch"); },
    run: async () => {
      await writeFile(path.join(root, "bun.lock"), lockfileContent(remote));
      return 0;
    },
  });

  assert.deepEqual(result, { state: "updated", commitDate: "2026-08-13" });
});
