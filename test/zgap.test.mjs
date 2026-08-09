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

test("login은 loopback PKCE를 검증하고 발급 키를 0600 파일에 저장한다", async (t) => {
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
    response.end(JSON.stringify({ access_token: "sk-agp-test", token_type: "Bearer" }));
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
  assert.deepEqual(JSON.parse(await readFile(credentialPath, "utf8")), { access_token: "sk-agp-test" });
  assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);

  const codexConfig = await readFile(path.join(codexHome, "config.toml"), "utf8");
  assert.match(codexConfig, /^model = "native-default"$/m);
  assert.match(codexConfig, /model_providers\.zgap = \{ name = "zgap", base_url = "https:\/\/ai-proxy\.zz\.gg\/v1"/);
  assert.match(codexConfig, new RegExp(credentialPathPattern(credentialPath)));
  assert.ok(codexConfig.indexOf("model_providers.zgap") < codexConfig.indexOf("[history]"));
  assert.doesNotMatch(codexConfig, /^model_provider\s*=/m);
});

test("codex는 기본 Codex home을 유지하고 proxy provider와 파일 기반 키만 주입한다", async (t) => {
  const root = await tempDir(t);
  const home = path.join(root, "home");
  const configRoot = path.join(root, "config");
  const configDir = path.join(configRoot, "zgap");
  const fakeBin = path.join(root, "bin");
  await mkdir(configDir, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(path.join(configDir, "credentials.json"), JSON.stringify({ access_token: "sk-agp-secret" }), { mode: 0o600 });

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
  assert.match(joined, new RegExp(credentialPathPattern(path.join(configDir, "credentials.json"))));
  assert.doesNotMatch(joined, /sk-agp-secret/);
  assert.equal(invocation.argv.includes("--profile"), false);
  assert.doesNotMatch(joined, /model_catalog_json/);
  await assert.rejects(access(path.join(home, ".codex")), { code: "ENOENT" });
});

function credentialPathPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
