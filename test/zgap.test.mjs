import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
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
  assert.match(stdout, /Codex App and CLI share history/);
});

test("login은 loopback PKCE를 검증하고 디바이스 token pair를 0600 파일에 저장한다", async (t) => {
  const root = await tempDir(t);
  const configDir = path.join(root, "config", "zgap");
  const codexHome = path.join(root, "codex");
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(codexHome, "config.toml"), 'model = "native-default"\n\n[history]\npersistence = "save-all"\n');
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

  const { login } = await import("../bin/zgap.mjs");
  await login({
    codexHome,
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
      assert.equal((await fetch(callback)).status, 200);
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

  const codexConfig = await readFile(path.join(codexHome, "config.toml"), "utf8");
  assert.match(codexConfig, /^model = "native-default"$/m);
  assert.match(codexConfig, /model_providers\.zgap = \{ name = "zgap", base_url = "https:\/\/ai-proxy\.zz\.gg\/v1"/);
  assert.match(codexConfig, new RegExp(credentialPathPattern(credentialPath)));
  assert.ok(codexConfig.indexOf("model_providers.zgap") < codexConfig.indexOf("[history]"));
  assert.doesNotMatch(codexConfig, /^model_provider\s*=/m);
});

test("codex는 기본 Codex home을 유지하고 refresh 가능한 auth command만 주입한다", async (t) => {
  const root = await tempDir(t);
  const home = path.join(root, "home");
  const configRoot = path.join(root, "config");
  const configDir = path.join(configRoot, "zgap");
  const fakeBin = path.join(root, "bin");
  await mkdir(configDir, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(path.join(configDir, "credentials.json"), JSON.stringify({
    access_expires_at: "2099-01-02T00:00:00.000Z",
    access_token: ACCESS_OLD,
    device_id: "d".repeat(43),
    origin: "https://ai-proxy.zz.gg",
    refresh_expires_at: "2099-01-05T00:00:00.000Z",
    refresh_token: REFRESH_OLD,
  }), { mode: 0o600 });

  const fakeCodex = path.join(fakeBin, "codex");
  await writeFile(fakeCodex, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  codexHome: process.env.CODEX_HOME ?? null,
  openaiBaseUrl: process.env.OPENAI_BASE_URL ?? null,
  openaiApiKey: process.env.OPENAI_API_KEY ?? null,
  zgapApiKey: process.env.ZGAP_API_KEY ?? null,
}));
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

  const joined = invocation.argv.join("\n");
  assert.match(joined, /model_provider="zgap"/);
  assert.match(joined, /model_providers\.zgap=\{name="zgap",base_url="https:\/\/ai-proxy\.zz\.gg\/v1"/);
  assert.match(joined, /auth=\{command=/);
  assert.match(joined, /auth-token/);
  assert.match(joined, new RegExp(credentialPathPattern(path.join(configDir, "credentials.json"))));
  assert.equal(joined.includes(ACCESS_OLD), false);
  assert.equal(joined.includes(REFRESH_OLD), false);
  assert.equal(invocation.argv.includes("--profile"), false);
  assert.doesNotMatch(joined, /model_catalog_json/);
  await assert.rejects(access(path.join(home, ".codex")), { code: "ENOENT" });
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
  const { resolveAccessToken } = await import("../bin/zgap.mjs");

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

test("기존 API-key credential 파일은 재로그인을 요구한다", async (t) => {
  const root = await tempDir(t);
  const credentialPath = path.join(root, "credentials.json");
  await writeFile(credentialPath, JSON.stringify({ access_token: "sk-agp-u-old" }), { mode: 0o600 });
  const { resolveAccessToken } = await import("../bin/zgap.mjs");
  await assert.rejects(
    () => resolveAccessToken({ credentialFile: credentialPath }),
    /Invalid zgap credentials\. Run `zgap login` again\./,
  );
});

function credentialPathPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
