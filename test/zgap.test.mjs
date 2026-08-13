import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoDir, "bin", "zgap.mjs");
const ACCESS_OLD = `zgap-at-${"a".repeat(43)}`;
const ACCESS_NEW = `zgap-at-${"b".repeat(43)}`;
const REFRESH_OLD = `zgap-rt-${"c".repeat(43)}`;
const REFRESH_NEW = `zgap-rt-${"d".repeat(43)}`;

async function tempDir(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zgap-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function runCli(args, env) {
  const child = spawn(process.execPath, [cliPath, ...args], { env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code, signal] = await once(child, "exit");
  return { code, signal, stdout, stderr };
}

async function runCatalogFailureScenario(t, { serverBody, bundledOutput, expectedError }) {
  const root = await tempDir(t);
  const home = path.join(root, "home");
  const configRoot = path.join(root, "config");
  const configDir = path.join(configRoot, "zgap");
  const fakeBin = path.join(root, "bin");
  const marker = path.join(root, "codex-ran");
  await mkdir(configDir, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  const gateway = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(serverBody));
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  t.after(() => gateway.close());
  await writeFile(path.join(configDir, "credentials.json"), JSON.stringify({
    access_expires_at: "2099-01-02T00:00:00.000Z",
    access_token: ACCESS_OLD,
    device_id: "d".repeat(43),
    origin: `http://127.0.0.1:${gateway.address().port}`,
    refresh_expires_at: "2099-01-05T00:00:00.000Z",
    refresh_token: REFRESH_OLD,
  }), { mode: 0o600 });
  const fakeCodex = path.join(fakeBin, "codex");
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("codex-cli 1.0.0\\n");
else if (args.join(" ") === "debug models --bundled") process.stdout.write(${JSON.stringify(bundledOutput)});
else writeFileSync(${JSON.stringify(marker)}, "ran");
`);
  await chmod(fakeCodex, 0o755);
  const result = await runCli(["codex"], {
    HOME: home,
    XDG_CONFIG_HOME: configRoot,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
  });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, expectedError);
  await assert.rejects(access(marker), { code: "ENOENT" });
}

test("npm bin 심볼릭 링크로 실행해도 CLI main이 시작된다", async (t) => {
  const root = await tempDir(t);
  const shim = path.join(root, "zgap");
  await symlink(cliPath, shim);
  const child = spawn(shim, ["--help"]);
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.match(stdout, /zgap login/);
  assert.match(stdout, /normal ~\/\.codex and ~\/\.claude directories/);
});

test("Codex PATH의 빈 항목은 현재 디렉터리를 사용하고 실행 가능한 디렉터리는 건너뛴다", async (t) => {
  const root = await tempDir(t);
  const directoryCandidate = path.join(root, "codex");
  const executableCandidate = path.join(root, "bin", "codex");
  await mkdir(directoryCandidate, { recursive: true });
  await mkdir(path.dirname(executableCandidate), { recursive: true });
  await writeFile(executableCandidate, "#!/bin/sh\n");
  await chmod(executableCandidate, 0o755);
  const { resolveCodexExecutable } = await import("../src/catalog.mjs");
  assert.equal(
    await resolveCodexExecutable({ env: { PATH: `${path.delimiter}${path.join(root, "bin")}` }, cwd: root }),
    await realpath(executableCandidate),
  );
});

test("Codex version은 전체 출력이 codex-cli 형식일 때만 허용한다", async (t) => {
  const root = await tempDir(t);
  const fakeCodex = path.join(root, "codex");
  await writeFile(fakeCodex, "#!/bin/sh\nprintf 'unexpected prefix codex-cli 1.0.0\\n'\n");
  await chmod(fakeCodex, 0o755);
  const { readCodexVersion } = await import("../src/catalog.mjs");
  await assert.rejects(() => readCodexVersion(fakeCodex), /invalid response/);
});

test("malformed zgap policy는 Codex 실행 전에 중단한다", async (t) => {
  await runCatalogFailureScenario(t, {
    serverBody: { models: [{ slug: "openai/gpt-5.6-luna" }] },
    bundledOutput: JSON.stringify({ models: [{ slug: "openai/gpt-5.6-luna" }] }),
    expectedError: /invalid zgap_client_policy/,
  });
});

test("malformed bundled catalog는 Codex 실행 전에 중단한다", async (t) => {
  await runCatalogFailureScenario(t, {
    serverBody: {
      models: [{ slug: "openai/gpt-5.6-luna" }],
      zgap_client_policy: { openai_models: { mode: "replace_with_local_bundle" } },
    },
    bundledOutput: "not-json",
    expectedError: /Bundled model catalog returned an invalid response/,
  });
});

test("최종 catalog의 중복 slug는 Codex 실행 전에 중단한다", async (t) => {
  await runCatalogFailureScenario(t, {
    serverBody: {
      models: [{ slug: "anthropic/claude", provider: "anthropic" }],
      zgap_client_policy: { openai_models: { mode: "replace_with_local_bundle" } },
    },
    bundledOutput: JSON.stringify({ models: [{ slug: "anthropic/claude" }] }),
    expectedError: /duplicate slug: anthropic\/claude/,
  });
});

test("login은 loopback PKCE를 검증하고 디바이스 token pair를 0600 파일에 저장한다", async (t) => {
  const root = await tempDir(t);
  const configDir = path.join(root, "config", "zgap");
  const home = path.join(root, "home");
  const codexHome = path.join(home, ".codex");
  await mkdir(codexHome, { recursive: true });
  const originalCodexConfig = 'model = "native-default"\n\n[history]\npersistence = "save-all"\n';
  await writeFile(path.join(codexHome, "config.toml"), originalCodexConfig);
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  let tokenRequest;
  let authorizeUrl;

  const oauth = createServer(async (request, response) => {
    assert.equal(request.url, "/cli/oauth/token");
    assert.equal(request.method, "POST");
    let body = "";
    for await (const chunk of request) body += chunk;
    tokenRequest = JSON.parse(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      access_token: ACCESS_NEW,
      expires_in: 86_400,
      refresh_expires_in: 345_600,
      refresh_token: REFRESH_NEW,
      token_type: "Bearer",
    }));
  });
  oauth.listen(0, "127.0.0.1");
  await once(oauth, "listening");
  t.after(() => oauth.close());
  const origin = `http://127.0.0.1:${oauth.address().port}`;

  const { login } = await import("../src/login.mjs");
  await login({
    configDir,
    origin,
    now: () => Date.parse("2026-08-11T00:00:00.000Z"),
    timeoutMs: 2_000,
    log() {},
    async openBrowser(url) {
      authorizeUrl = new URL(url);
      const callback = new URL(authorizeUrl.searchParams.get("redirect_uri"));
      const state = authorizeUrl.searchParams.get("state");

      callback.searchParams.set("code", "c".repeat(43));
      callback.searchParams.set("state", `${state}wrong`);
      assert.equal((await fetch(callback)).status, 400);

      callback.searchParams.set("state", state);
      const response = await fetch(callback, { redirect: "manual" });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), `${origin}/console/cli-auth?result=success`);
    },
  });

  assert.equal(authorizeUrl.origin, origin);
  assert.equal(authorizeUrl.pathname, "/console/cli-auth");
  assert.equal(authorizeUrl.searchParams.get("client_id"), "zgap");
  assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
  assert.match(authorizeUrl.searchParams.get("device_id"), /^[A-Za-z0-9_-]{43}$/);
  assert.match(authorizeUrl.searchParams.get("state"), /^[A-Za-z0-9_-]{43}$/);
  assert.match(tokenRequest.code_verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    createHash("sha256").update(tokenRequest.code_verifier).digest("base64url"),
    authorizeUrl.searchParams.get("code_challenge"),
  );
  assert.equal(tokenRequest.redirect_uri, authorizeUrl.searchParams.get("redirect_uri"));
  assert.equal(tokenRequest.code, "c".repeat(43));
  assert.equal(tokenRequest.client_id, "zgap");
  assert.equal(tokenRequest.grant_type, "authorization_code");

  const credentialPath = path.join(configDir, "credentials.json");
  assert.deepEqual(JSON.parse(await readFile(credentialPath, "utf8")), {
    access_expires_at: "2026-08-12T00:00:00.000Z",
    access_token: ACCESS_NEW,
    device_id: authorizeUrl.searchParams.get("device_id"),
    origin,
    refresh_expires_at: "2026-08-15T00:00:00.000Z",
    refresh_token: REFRESH_NEW,
  });
  assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);

  assert.equal(await readFile(path.join(codexHome, "config.toml"), "utf8"), originalCodexConfig);
});

test("login은 Codex config가 없어도 .codex/config.toml을 만들지 않는다", async (t) => {
  const root = await tempDir(t);
  const configDir = path.join(root, "config", "zgap");
  const home = path.join(root, "home");
  const codexHome = path.join(home, ".codex");
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  let oauth;
  oauth = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request body */ }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      access_token: ACCESS_NEW,
      expires_in: 86_400,
      refresh_expires_in: 345_600,
      refresh_token: REFRESH_NEW,
      token_type: "Bearer",
    }));
  });
  oauth.listen(0, "127.0.0.1");
  await once(oauth, "listening");
  t.after(() => oauth.close());
  const origin = `http://127.0.0.1:${oauth.address().port}`;

  const { login } = await import("../src/login.mjs");
  await login({
    configDir,
    origin,
    timeoutMs: 2_000,
    log() {},
    async openBrowser(url) {
      const authorizeUrl = new URL(url);
      const callback = new URL(authorizeUrl.searchParams.get("redirect_uri"));
      callback.searchParams.set("code", "c".repeat(43));
      callback.searchParams.set("state", authorizeUrl.searchParams.get("state"));
      await fetch(callback, { redirect: "manual" });
    },
  });

  await assert.rejects(access(path.join(codexHome, "config.toml")), { code: "ENOENT" });
});

test("login은 callback client가 연결을 유지해도 종료한다", async (t) => {
  const root = await tempDir(t);
  const configDir = path.join(root, "config", "zgap");
  let idleSocket;

  const oauth = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request body */ }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      access_token: ACCESS_NEW,
      expires_in: 86_400,
      refresh_expires_in: 345_600,
      refresh_token: REFRESH_NEW,
      token_type: "Bearer",
    }));
  });
  oauth.listen(0, "127.0.0.1");
  await once(oauth, "listening");
  t.after(() => oauth.close());
  const origin = `http://127.0.0.1:${oauth.address().port}`;

  const { login } = await import("../src/login.mjs");
  const loginPromise = login({
    configDir,
    origin,
    timeoutMs: 2_000,
    log() {},
    async openBrowser(url) {
      const authorizeUrl = new URL(url);
      const callback = new URL(authorizeUrl.searchParams.get("redirect_uri"));
      idleSocket = connect(Number(callback.port), callback.hostname);
      await once(idleSocket, "connect");
      callback.searchParams.set("code", "c".repeat(43));
      callback.searchParams.set("state", authorizeUrl.searchParams.get("state"));
      await fetch(callback, { redirect: "manual" });
    },
  });

  try {
    await Promise.race([
      loginPromise,
      delay(250).then(() => { throw new Error("login did not exit after callback"); }),
    ]);
  } finally {
    idleSocket?.destroy();
    await loginPromise;
  }
});

test("codex는 기본 Codex home을 유지하고 refresh 가능한 auth command만 주입한다", async (t) => {
  const root = await tempDir(t);
  const home = path.join(root, "home");
  const configRoot = path.join(root, "config");
  const configDir = path.join(configRoot, "zgap");
  const fakeBin = path.join(root, "bin");
  await mkdir(configDir, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  let modelRequest;
  const gateway = createServer(async (request, response) => {
    modelRequest = { authorization: request.headers.authorization, url: request.url };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      models: [
        { slug: "openai/gpt-5.6-luna", provider: "openai" },
        { slug: "anthropic/claude", provider: "anthropic" },
      ],
      zgap_client_policy: { openai_models: { mode: "replace_with_local_bundle" } },
    }));
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  t.after(() => gateway.close());
  const origin = `http://127.0.0.1:${gateway.address().port}`;
  await writeFile(path.join(configDir, "credentials.json"), JSON.stringify({
    access_expires_at: "2099-01-02T00:00:00.000Z",
    access_token: ACCESS_OLD,
    device_id: "d".repeat(43),
    origin,
    refresh_expires_at: "2099-01-05T00:00:00.000Z",
    refresh_token: REFRESH_OLD,
  }), { mode: 0o600 });

  const fakeCodex = path.join(fakeBin, "codex");
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("codex-cli 9.8.7\\n");
else if (args.join(" ") === "debug models --bundled") process.stdout.write(JSON.stringify({ models: [{ slug: "openai/gpt-5.6-luna", title: "Bundled" }] }));
else {
  const catalogPath = args.find((arg) => arg.startsWith("model_catalog_json="))?.slice("model_catalog_json=".length);
  process.stdout.write(JSON.stringify({
    argv: args,
    codexHome: process.env.CODEX_HOME ?? null,
    openaiBaseUrl: process.env.OPENAI_BASE_URL ?? null,
    openaiApiKey: process.env.OPENAI_API_KEY ?? null,
    zgapApiKey: process.env.ZGAP_API_KEY ?? null,
    catalog: JSON.parse(readFileSync(JSON.parse(catalogPath), "utf8")),
    catalogMode: statSync(JSON.parse(catalogPath)).mode & 0o777,
    catalogDirectoryMode: statSync(JSON.parse(catalogPath).replace(/\\/catalog\\.json$/, "")).mode & 0o777,
  }));
}
`);
  await chmod(fakeCodex, 0o755);

  const result = await runCli(["codex", "exec", "hello"], {
    HOME: home,
    XDG_CONFIG_HOME: configRoot,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    CODEX_HOME: path.join(root, "separate-codex-home"),
    OPENAI_BASE_URL: "https://wrong.example",
  });
  assert.equal(result.code, 0, result.stderr);
  const invocation = JSON.parse(result.stdout);
  assert.equal(invocation.codexHome, null);
  assert.equal(invocation.openaiBaseUrl, null);
  assert.equal(invocation.openaiApiKey, null);
  assert.equal(invocation.zgapApiKey, null);
  assert.deepEqual(invocation.argv.slice(-2), ["exec", "hello"]);
  assert.deepEqual(modelRequest, {
    authorization: `Bearer ${ACCESS_OLD}`,
    url: "/v1/models?client_version=9.8.7",
  });

  const joined = invocation.argv.join("\n");
  assert.match(joined, /model_provider="zgap"/);
  assert.match(joined, /model_providers\.zgap=\{name="zgap",base_url="https:\/\/ai-proxy\.zz\.gg\/v1"/);
  assert.match(joined, /auth=\{command=/);
  assert.match(joined, /auth-token/);
  assert.match(joined, new RegExp(credentialPathPattern(path.join(configDir, "credentials.json"))));
  assert.equal(joined.includes(ACCESS_OLD), false);
  assert.equal(joined.includes(REFRESH_OLD), false);
  assert.equal(invocation.argv.includes("--profile"), false);
  const modelCatalog = joined.match(/model_catalog_json=("[^"]+")/)?.[1];
  assert.ok(modelCatalog);
  assert.match(JSON.parse(modelCatalog), new RegExp(`${path.sep}zgap-[^${path.sep}]+${path.sep}catalog\\.json$`));
  assert.deepEqual(invocation.catalog.models, [
    { slug: "openai/gpt-5.6-luna", title: "Bundled" },
    { slug: "anthropic/claude" },
  ]);
  assert.equal(invocation.catalogMode, 0o600);
  assert.equal(invocation.catalogDirectoryMode, 0o700);
  await assert.rejects(access(JSON.parse(modelCatalog)), { code: "ENOENT" });
  await assert.rejects(access(path.join(configDir, "models.json")), { code: "ENOENT" });
  await assert.rejects(access(path.join(home, ".codex")), { code: "ENOENT" });
});

test("SIGTERM은 Codex 자식에 전달한 뒤 catalog를 정리하고 wrapper도 SIGTERM으로 종료한다", async (t) => {
  const root = await tempDir(t);
  const home = path.join(root, "home");
  const configRoot = path.join(root, "config");
  const configDir = path.join(configRoot, "zgap");
  const fakeBin = path.join(root, "bin");
  const marker = path.join(root, "signal-marker.json");
  await mkdir(configDir, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  const gateway = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      models: [{ slug: "openai/gpt-5.6-luna", provider: "openai" }],
      zgap_client_policy: { openai_models: { mode: "replace_with_local_bundle" } },
    }));
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  t.after(() => gateway.close());
  await writeFile(path.join(configDir, "credentials.json"), JSON.stringify({
    access_expires_at: "2099-01-02T00:00:00.000Z",
    access_token: ACCESS_OLD,
    device_id: "d".repeat(43),
    origin: `http://127.0.0.1:${gateway.address().port}`,
    refresh_expires_at: "2099-01-05T00:00:00.000Z",
    refresh_token: REFRESH_OLD,
  }), { mode: 0o600 });
  const fakeCodex = path.join(fakeBin, "codex");
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("codex-cli 1.0.0\\n");
else if (args.join(" ") === "debug models --bundled") process.stdout.write(JSON.stringify({ models: [{ slug: "openai/gpt-5.6-luna" }] }));
else {
  const catalogPath = JSON.parse(args.find((arg) => arg.startsWith("model_catalog_json=")).slice("model_catalog_json=".length));
  writeFileSync(process.env.FAKE_CODEX_SIGNAL_MARKER, JSON.stringify({ pid: process.pid, catalogPath, catalog: readFileSync(catalogPath, "utf8") }));
  setInterval(() => {}, 1_000);
}
`);
  await chmod(fakeCodex, 0o755);

  const wrapper = spawn(process.execPath, [cliPath, "codex"], {
    env: {
      HOME: home,
      XDG_CONFIG_HOME: configRoot,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      FAKE_CODEX_SIGNAL_MARKER: marker,
    },
  });
  let stderr = "";
  let markerData;
  wrapper.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => {
    if (!wrapper.killed) wrapper.kill("SIGKILL");
    if (markerData?.pid) {
      try { process.kill(markerData.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  });
  for (let attempt = 0; attempt < 100 && !markerData; attempt += 1) {
    markerData = await readFile(marker, "utf8").then(JSON.parse).catch(() => null);
    if (!markerData) await delay(20);
  }
  assert.ok(markerData, stderr);
  assert.match(markerData.catalogPath, new RegExp(`${path.sep}zgap-[^${path.sep}]+${path.sep}catalog\\.json$`));
  await access(markerData.catalogPath);
  const childExit = once(wrapper, "exit");
  process.kill(wrapper.pid, "SIGTERM");
  const [code, signal] = await childExit;
  assert.equal(code, null, stderr);
  assert.equal(signal, "SIGTERM", stderr);
  await assert.rejects(access(markerData.catalogPath), { code: "ENOENT" });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(markerData.pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await delay(20);
  }
  assert.fail("Codex child survived wrapper SIGTERM");
});

test("codex는 설정 파일의 model_catalog_json보다 실행 인자 catalog를 우선한다", async (t) => {
  const root = await tempDir(t);
  const home = path.join(root, "home");
  const configRoot = path.join(root, "config");
  const configDir = path.join(configRoot, "zgap");
  const codexHome = path.join(home, ".codex");
  const fakeBin = path.join(root, "bin");
  const codexMarker = path.join(root, "codex-ran");
  await mkdir(configDir, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  const existingConfig = `model_catalog_json = ${JSON.stringify(path.join(codexHome, "existing-catalog.json"))}\n`;
  await writeFile(path.join(codexHome, "config.toml"), existingConfig);

  let modelRequests = 0;
  const gateway = createServer((_request, response) => {
    modelRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      models: [{ slug: "openai/gpt-5.6-luna", provider: "openai" }],
      zgap_client_policy: { openai_models: { mode: "replace_with_local_bundle" } },
    }));
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  t.after(() => gateway.close());
  const origin = `http://127.0.0.1:${gateway.address().port}`;
  await writeFile(path.join(configDir, "credentials.json"), JSON.stringify({
    access_expires_at: "2099-01-02T00:00:00.000Z",
    access_token: ACCESS_OLD,
    device_id: "d".repeat(43),
    origin,
    refresh_expires_at: "2099-01-05T00:00:00.000Z",
    refresh_token: REFRESH_OLD,
  }), { mode: 0o600 });

  const fakeCodex = path.join(fakeBin, "codex");
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("codex-cli 1.0.0\\n");
else if (args.join(" ") === "debug models --bundled") process.stdout.write(JSON.stringify({ models: [{ slug: "openai/gpt-5.6-luna" }] }));
else writeFileSync(process.env.FAKE_CODEX_MARKER, "ran");
`);
  await chmod(fakeCodex, 0o755);

  const result = await runCli(["codex"], {
    HOME: home,
    XDG_CONFIG_HOME: configRoot,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    FAKE_CODEX_MARKER: codexMarker,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(modelRequests, 1);
  assert.equal(await readFile(codexMarker, "utf8"), "ran");
  assert.equal(await readFile(path.join(codexHome, "config.toml"), "utf8"), existingConfig);
});

test("claude는 gateway 환경과 apiKeyHelper 설정만 프로세스에 주입한다", async (t) => {
  const root = await tempDir(t);
  const home = path.join(root, "home");
  const configRoot = path.join(root, "config");
  const configDir = path.join(configRoot, "zgap");
  const fakeBin = path.join(root, "bin");
  const marker = path.join(root, "claude.json");
  await mkdir(configDir, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(path.join(configDir, "credentials.json"), "{}");
  const fakeClaude = path.join(fakeBin, "claude");
  await writeFile(fakeClaude, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.FAKE_CLAUDE_MARKER, JSON.stringify({
  argv: process.argv.slice(2),
  env: Object.fromEntries(["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "CLAUDE_CODE_API_BASE_URL", "CLAUDE_CODE_PROXY_URL", "CLAUDE_CODE_SESSION_ACCESS_TOKEN", "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "CLAUDE_CONFIG_DIR"].map((key) => [key, process.env[key] ?? null])),
}));
process.exitCode = 7;
`);
  await chmod(fakeClaude, 0o755);
  const result = await runCli(["claude", "--print", "hello"], { HOME: home, XDG_CONFIG_HOME: configRoot, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, FAKE_CLAUDE_MARKER: marker, ANTHROPIC_BASE_URL: "https://wrong.example", ANTHROPIC_API_KEY: "wrong-key", ANTHROPIC_AUTH_TOKEN: "wrong-token", ANTHROPIC_FOUNDRY_API_KEY: "wrong-key", CLAUDE_CODE_API_BASE_URL: "https://wrong.example", CLAUDE_CODE_PROXY_URL: "https://wrong.example", CLAUDE_CODE_SESSION_ACCESS_TOKEN: "wrong-token", CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CONFIG_DIR: path.join(root, "wrong-claude") });
  assert.equal(result.code, 7, result.stderr);
  const invocation = JSON.parse(await readFile(marker, "utf8"));
  assert.deepEqual(invocation.argv.slice(-2), ["--print", "hello"]);
  const settingsIndex = invocation.argv.indexOf("--settings");
  assert.ok(settingsIndex >= 0);
  const settings = JSON.parse(invocation.argv[settingsIndex + 1]);
  assert.match(settings.apiKeyHelper, /auth-token/);
  assert.match(settings.apiKeyHelper, /credentials\.json/);
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://ai-proxy.zz.gg");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "claude-opus-5[1m]");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "claude-sonnet-5[1m]");
  assert.equal(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
  assert.equal(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "262144");
  assert.equal(settings.env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK, "1");
  for (const name of [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_AWS_API_KEY", "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_FOUNDRY_AUTH_TOKEN", "ANTHROPIC_VERTEX_PROJECT_ID", "CLAUDE_CODE_API_BASE_URL",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "CLAUDE_CODE_PROXY_AUTHENTICATE", "CLAUDE_CODE_PROXY_URL",
    "CLAUDE_CODE_SESSION_ACCESS_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_GATEWAY", "CLAUDE_CODE_USE_VERTEX",
  ]) assert.equal(settings.env[name], "", name);
  assert.equal(invocation.env.ANTHROPIC_BASE_URL, "https://ai-proxy.zz.gg");
  assert.equal(invocation.env.ANTHROPIC_API_KEY, null);
  assert.equal(invocation.env.ANTHROPIC_AUTH_TOKEN, null);
  assert.equal(invocation.env.ANTHROPIC_FOUNDRY_API_KEY, null);
  assert.equal(invocation.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "claude-opus-5[1m]");
  assert.equal(invocation.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "claude-sonnet-5[1m]");
  assert.equal(invocation.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
  assert.equal(invocation.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "262144");
  assert.equal(invocation.env.CLAUDE_CODE_API_BASE_URL, null);
  assert.equal(invocation.env.CLAUDE_CODE_PROXY_URL, null);
  assert.equal(invocation.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN, null);
  assert.equal(invocation.env.CLAUDE_CODE_USE_BEDROCK, null);
  assert.equal(invocation.env.CLAUDE_CODE_USE_VERTEX, null);
  assert.equal(invocation.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, null);
  assert.equal(invocation.env.CLAUDE_CONFIG_DIR, path.join(root, "wrong-claude"));
});

test("claude는 사용자 --settings를 거부한다", async (t) => {
  const root = await tempDir(t);
  const fakeBin = path.join(root, "bin");
  await mkdir(fakeBin, { recursive: true });
  const marker = path.join(root, "ran");
  const fakeClaude = path.join(fakeBin, "claude");
  await writeFile(fakeClaude, `#!/bin/sh\ntouch ${marker}\n`);
  await chmod(fakeClaude, 0o755);
  const result = await runCli(["claude", "--settings", "{}"], { PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--settings/);
  await assert.rejects(access(marker), { code: "ENOENT" });
});

test("claude가 PATH에 없으면 명확한 오류를 반환한다", async () => {
  const result = await runCli(["claude"], { PATH: "" });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Claude CLI is not installed or not in PATH/);
});

test("auth-token은 전체 CLI 모듈 없이 credential 경로만 실행한다", async (t) => {
  const root = await tempDir(t);
  const isolatedCli = path.join(root, "bin", "zgap.mjs");
  const isolatedSrc = path.join(root, "src");
  const credentialPath = path.join(root, "credentials.json");
  await mkdir(path.dirname(isolatedCli), { recursive: true });
  await mkdir(isolatedSrc, { recursive: true });
  await writeFile(isolatedCli, await readFile(cliPath));
  for (const name of ["constants.mjs", "credentials.mjs"]) {
    await writeFile(path.join(isolatedSrc, name), await readFile(path.join(repoDir, "src", name)));
  }
  await writeFile(credentialPath, JSON.stringify({
    access_expires_at: "2099-01-02T00:00:00.000Z",
    access_token: ACCESS_OLD,
    device_id: "d".repeat(43),
    origin: "https://ai-proxy.zz.gg",
    refresh_expires_at: "2099-01-05T00:00:00.000Z",
    refresh_token: REFRESH_OLD,
  }), { mode: 0o600 });

  const child = spawn(process.execPath, [isolatedCli, "auth-token", credentialPath]);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "exit");

  assert.equal(code, 0, stderr);
  assert.equal(stdout, ACCESS_OLD);
});

test("auth-token은 만료 임박 access를 한 번만 refresh하고 rotation 결과를 원자 저장한다", async (t) => {
  const root = await tempDir(t);
  const configDir = path.join(root, "config", "zgap");
  await mkdir(configDir, { recursive: true });
  const credentialPath = path.join(configDir, "credentials.json");
  await writeFile(credentialPath, JSON.stringify({
    access_expires_at: "2026-08-11T00:04:00.000Z",
    access_token: ACCESS_OLD,
    device_id: "d".repeat(43),
    origin: "https://ai-proxy.zz.gg",
    refresh_expires_at: "2026-08-14T00:00:00.000Z",
    refresh_token: REFRESH_OLD,
  }), { mode: 0o600 });
  let refreshCalls = 0;
  const fetchImpl = async (_url, options) => {
    refreshCalls += 1;
    assert.deepEqual(JSON.parse(options.body), {
      client_id: "zgap",
      grant_type: "refresh_token",
      refresh_token: REFRESH_OLD,
    });
    return new Response(JSON.stringify({
      access_token: ACCESS_NEW,
      expires_in: 86_400,
      refresh_expires_in: 345_600,
      refresh_token: REFRESH_NEW,
      token_type: "Bearer",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const { resolveAccessToken } = await import("../src/credentials.mjs");

  const [first, second] = await Promise.all([
    resolveAccessToken({ credentialFile: credentialPath, fetchImpl, now: () => Date.parse("2026-08-11T00:00:00.000Z") }),
    resolveAccessToken({ credentialFile: credentialPath, fetchImpl, now: () => Date.parse("2026-08-11T00:00:00.000Z") }),
  ]);

  assert.equal(first, ACCESS_NEW);
  assert.equal(second, ACCESS_NEW);
  assert.equal(refreshCalls, 1);
  const saved = JSON.parse(await readFile(credentialPath, "utf8"));
  assert.equal(saved.access_token, ACCESS_NEW);
  assert.equal(saved.refresh_token, REFRESH_NEW);
  assert.equal(saved.device_id, "d".repeat(43));
  assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
});

test("auth-token은 refresh 요청이 멈추면 lock 만료 전에 중단한다", async (t) => {
  const root = await tempDir(t);
  const credentialPath = path.join(root, "credentials.json");
  await writeFile(credentialPath, JSON.stringify({
    access_expires_at: "2026-08-11T00:04:00.000Z",
    access_token: ACCESS_OLD,
    device_id: "d".repeat(43),
    origin: "https://ai-proxy.zz.gg",
    refresh_expires_at: "2026-08-14T00:00:00.000Z",
    refresh_token: REFRESH_OLD,
  }), { mode: 0o600 });
  const { resolveAccessToken } = await import("../src/credentials.mjs");

  await assert.rejects(
    () => resolveAccessToken({
      credentialFile: credentialPath,
      now: () => Date.parse("2026-08-11T00:00:00.000Z"),
      requestTimeoutMs: 5,
      async fetchImpl(_url, options) {
        if (!(options.signal instanceof AbortSignal)) throw new Error("missing abort signal");
        await once(options.signal, "abort");
        throw options.signal.reason;
      },
    }),
    (error) => error?.name === "TimeoutError",
  );
});

test("기존 API-key credential 파일은 재로그인을 요구한다", async (t) => {
  const root = await tempDir(t);
  const credentialPath = path.join(root, "credentials.json");
  await writeFile(credentialPath, JSON.stringify({ access_token: "sk-agp-u-old" }), { mode: 0o600 });
  const { resolveAccessToken } = await import("../src/credentials.mjs");
  await assert.rejects(
    () => resolveAccessToken({ credentialFile: credentialPath }),
    /Invalid zgap credentials\. Run `zgap login` again\./,
  );
});

test("credential 상태는 refresh session의 유효성만으로 로그인 상태를 구분한다", async (t) => {
  const root = await tempDir(t);
  const signedInFile = path.join(root, "signed-in.json");
  const expiredFile = path.join(root, "expired.json");
  const invalidFile = path.join(root, "invalid.json");
  const invalidShapeFile = path.join(root, "invalid-shape.json");
  const unreadablePath = path.join(root, "directory");
  const now = Date.parse("2026-08-12T00:00:00.000Z");
  const credential = {
    access_expires_at: "2026-08-11T00:00:00.000Z",
    access_token: ACCESS_OLD,
    device_id: "d".repeat(43),
    origin: "https://ai-proxy.zz.gg",
    refresh_expires_at: "2026-08-13T00:00:00.000Z",
    refresh_token: REFRESH_OLD,
  };
  await writeFile(signedInFile, JSON.stringify(credential), { mode: 0o600 });
  await writeFile(expiredFile, JSON.stringify({
    ...credential,
    refresh_expires_at: "2026-08-12T00:00:00.000Z",
  }), { mode: 0o600 });
  await writeFile(invalidFile, "not-json", { mode: 0o600 });
  await writeFile(invalidShapeFile, "null", { mode: 0o600 });
  await mkdir(unreadablePath);
  const { readCredentialState } = await import("../src/credentials.mjs");

  assert.equal(await readCredentialState({ credentialFile: signedInFile, now: () => now }), "signed-in");
  assert.equal(await readCredentialState({ credentialFile: expiredFile, now: () => now }), "expired");
  assert.equal(await readCredentialState({ credentialFile: path.join(root, "missing.json"), now: () => now }), "signed-out");
  assert.equal(await readCredentialState({ credentialFile: invalidFile, now: () => now }), "signed-out");
  assert.equal(await readCredentialState({ credentialFile: invalidShapeFile, now: () => now }), "signed-out");
  await assert.rejects(
    () => readCredentialState({ credentialFile: unreadablePath, now: () => now }),
    /Cannot read zgap credentials/,
  );
});

test("logout은 credential과 refresh lock을 제거하고 없는 상태에서도 성공한다", async (t) => {
  const configDir = await tempDir(t);
  const credentialFile = path.join(configDir, "credentials.json");
  const lockFile = `${credentialFile}.lock`;
  await writeFile(credentialFile, "secret", { mode: 0o600 });
  await writeFile(lockFile, "locked", { mode: 0o600 });
  const staleTime = new Date(Date.now() - 31_000);
  await utimes(lockFile, staleTime, staleTime);
  const { logout } = await import("../src/credentials.mjs");

  await logout({ configDir });
  await assert.rejects(access(credentialFile), { code: "ENOENT" });
  await assert.rejects(access(lockFile), { code: "ENOENT" });
  await logout({ configDir });
});

test("logout은 실행 중인 refresh의 오래된 lock을 제거하지 않는다", async (t) => {
  const configDir = await tempDir(t);
  const credentialFile = path.join(configDir, "credentials.json");
  const lockFile = `${credentialFile}.lock`;
  await writeFile(credentialFile, "secret", { mode: 0o600 });
  await writeFile(lockFile, `${process.pid}\n`, { mode: 0o600 });
  const staleTime = new Date(Date.now() - 31_000);
  await utimes(lockFile, staleTime, staleTime);
  const { logout } = await import("../src/credentials.mjs");

  const pendingLogout = logout({ configDir });
  await delay(75);
  assert.equal(await readFile(credentialFile, "utf8"), "secret");
  assert.equal(await readFile(lockFile, "utf8"), `${process.pid}\n`);

  await rm(lockFile);
  await pendingLogout;
  await assert.rejects(access(credentialFile), { code: "ENOENT" });
});

test("credential lock 해제는 다른 소유자의 lock을 제거하지 않는다", async (t) => {
  const configDir = await tempDir(t);
  const credentialFile = path.join(configDir, "credentials.json");
  const lockFile = `${credentialFile}.lock`;
  const replacement = "replacement-owner\n";
  const { withCredentialLock } = await import("../src/credentials.mjs");

  await withCredentialLock(credentialFile, async () => {
    await rm(lockFile);
    await writeFile(lockFile, replacement, { mode: 0o600 });
  });

  assert.equal(await readFile(lockFile, "utf8"), replacement);
});

for (const lockEntry of ["symbolic link", "directory"]) {
  test(`logout은 ${lockEntry} credential lock을 따라가지 않는다`, async (t) => {
    const configDir = await tempDir(t);
    const credentialFile = path.join(configDir, "credentials.json");
    const lockFile = `${credentialFile}.lock`;
    await writeFile(credentialFile, "secret", { mode: 0o600 });
    if (lockEntry === "symbolic link") {
      await symlink(path.join(configDir, "missing-lock-target"), lockFile);
    } else {
      await mkdir(lockFile);
    }
    const { logout } = await import("../src/credentials.mjs");

    await assert.rejects(() => logout({ configDir }), /Invalid zgap credential lock\./);
    assert.equal(await readFile(credentialFile, "utf8"), "secret");
  });
}

test("logout command는 local credential을 제거하고 완료를 출력한다", async (t) => {
  const root = await tempDir(t);
  const configRoot = path.join(root, "config");
  const configDir = path.join(configRoot, "zgap");
  const credentialFile = path.join(configDir, "credentials.json");
  await mkdir(configDir, { recursive: true });
  await writeFile(credentialFile, "secret", { mode: 0o600 });

  const result = await runCli(["logout"], {
    ...process.env,
    XDG_CONFIG_HOME: configRoot,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Logged out\./);
  await assert.rejects(access(credentialFile), { code: "ENOENT" });
});

function credentialPathPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
