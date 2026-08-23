import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "./harness.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoDir, "bin", "zgap.mjs");
const nodePath = execFileSync("which", ["node"], { encoding: "utf8" }).trim();
function jwt(email, id, origin = "https://ai-proxy.zz.gg") {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    encode({ alg: "EdDSA", typ: "JWT" }),
    encode({ iss: origin, aud: [origin], sub: "1", sid: "2", email, email_verified: true, iat: 1_700_000_000, exp: 1_800_000_000, proxy_products: [{ id, origin }] }),
    "sig",
  ].join(".");
}
const ACCESS_OLD = jwt("old@example.com", "codex");
const ACCESS_NEW = jwt("new@example.com", "claude");
const REFRESH_OLD = `zgap-rt-${"c".repeat(43)}`;
const REFRESH_NEW = `zgap-rt-${"d".repeat(43)}`;

test("JWT access token profile은 계약 필드만 표시용으로 해석한다", async () => {
  const { decodeAccessTokenProfile } = await import("../src/credentials.mjs");
  assert.deepEqual(decodeAccessTokenProfile(ACCESS_NEW), {
    email: "new@example.com",
    emailVerified: true,
    proxyProducts: [{ id: "claude", origin: "https://ai-proxy.zz.gg" }],
  });
  assert.equal(decodeAccessTokenProfile(`${ACCESS_NEW.slice(0, -1)}!`), null);
  assert.equal(decodeAccessTokenProfile(`${ACCESS_NEW}.${"a".repeat(16_384)}`), null);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = { iss: "https://ai-proxy.zz.gg", aud: ["https://ai-proxy.zz.gg"], sub: "1", sid: "2", email: "safe@example.com", email_verified: true, iat: 1, exp: 2, proxy_products: [{ id: "codex", origin: "https://ai-proxy.zz.gg" }] };
  assert.equal(decodeAccessTokenProfile(`${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.a`), null);
  assert.equal(decodeAccessTokenProfile(`${encode({ alg: "EdDSA", typ: "JWT" })}.${encode({ ...payload, iss: "https://evil.example" })}.a`), null);
  assert.equal(decodeAccessTokenProfile(`${encode({ alg: "EdDSA", typ: "JWT" })}.${encode({ ...payload, email: "bad\n@example.com" })}.a`), null);
  assert.equal(decodeAccessTokenProfile(`${encode({ alg: "EdDSA", typ: "JWT" })}.${encode({ ...payload, proxy_products: [{ id: "bad\u0000id", origin: "https://ai-proxy.zz.gg" }] })}.a`), null);
  const canonicalHeader = encode({ alg: "EdDSA", typ: "JWT" });
  const aliasHeader = `${canonicalHeader.slice(0, -1)}${canonicalHeader.endsWith("A") ? "B" : "A"}`;
  assert.equal(decodeAccessTokenProfile(`${aliasHeader}.${encode(payload)}.a`), null);
  assert.equal(decodeAccessTokenProfile(`${encode({ alg: "EdDSA", typ: "JWT" })}.${encode(payload)}.a`), null);
  assert.equal(decodeAccessTokenProfile(ACCESS_NEW, "https://proxy.example.test"), null);
  const configuredOrigin = "https://proxy.example.test";
  const configuredToken = jwt("host@example.com", "codex", configuredOrigin);
  assert.deepEqual(decodeAccessTokenProfile(configuredToken, configuredOrigin), {
    email: "host@example.com",
    emailVerified: true,
    proxyProducts: [{ id: "codex", origin: configuredOrigin }],
  });
});

test("credential origin은 JWT issuer와 같은 https origin만 허용한다", async (t) => {
  const root = await tempDir(t);
  const credentialPath = path.join(root, "credentials.json");
  await writeFile(credentialPath, JSON.stringify({ access_expires_at: "2099-01-02T00:00:00.000Z", access_token: ACCESS_NEW, device_id: "d".repeat(43), origin: "https://attacker.example", refresh_expires_at: "2099-01-05T00:00:00.000Z", refresh_token: REFRESH_OLD }));
  const { readCredentialFile } = await import("../src/credentials.mjs");
  await assert.rejects(() => readCredentialFile(credentialPath), /Invalid zgap credentials/);
});

test("설정 origin과 같은 JWT credential은 허용한다", async (t) => {
  const root = await tempDir(t);
  const origin = "https://proxy.example.test";
  const accessToken = jwt("new@example.com", "claude", origin);
  const credentialPath = path.join(root, "credentials.json");
  await writeFile(credentialPath, JSON.stringify({
    access_expires_at: "2099-01-02T00:00:00.000Z",
    access_token: accessToken,
    device_id: "d".repeat(43),
    origin,
    refresh_expires_at: "2099-01-05T00:00:00.000Z",
    refresh_token: REFRESH_OLD,
  }));
  const { readCredentialFile } = await import("../src/credentials.mjs");
  const credential = await readCredentialFile(credentialPath);
  assert.equal(credential.origin, origin);
  assert.equal(credential.access_token, accessToken);
});

async function tempDir(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zgap-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function runCli(args, env) {
  const child = spawn(nodePath, [cliPath, ...args], { env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code, signal] = await once(child, "exit");
  return { code, signal, stdout, stderr };
}

async function installGatewayFetchRedirect(t, port, origins = ["https://ai-proxy.zz.gg"]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zgap-fetch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modulePath = path.join(directory, "redirect-fetch.mjs");
  const gateway = JSON.stringify(`http://127.0.0.1:${port}`);
  const allowedOrigins = JSON.stringify(origins);
  await writeFile(modulePath, `const gateway = ${gateway};
const allowedOrigins = new Set(${allowedOrigins});
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const originalUrl = new URL(input?.url ?? input);
  if (!allowedOrigins.has(originalUrl.origin) || originalUrl.pathname !== "/v1/models") {
    return originalFetch(input, options);
  }
  const redirectedUrl = new URL(gateway);
  redirectedUrl.pathname = originalUrl.pathname;
  redirectedUrl.search = originalUrl.search;
  const redirectedInput = input instanceof Request ? new Request(redirectedUrl, input) : redirectedUrl;
  return originalFetch(redirectedInput, options);
};
`);
  return modulePath;
}

async function runCatalogFailureScenario(t, { serverBody, expectedError }) {
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
  const fetchRedirectModule = await installGatewayFetchRedirect(t, gateway.address().port);
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
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("codex-cli 1.0.0\\n");
else writeFileSync(${JSON.stringify(marker)}, "ran");
`);
  await chmod(fakeCodex, 0o755);
  const result = await runCli(["codex"], {
    HOME: home,
    XDG_CONFIG_HOME: configRoot,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    NODE_OPTIONS: `--import=${fetchRedirectModule}`,
  });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, expectedError);
  await assert.rejects(access(marker), { code: "ENOENT" });
}

test("심볼릭 링크로 실행해도 CLI main이 시작된다", async (t) => {
  const root = await tempDir(t);
  const shim = path.join(root, "zgap");
  await symlink(cliPath, shim);
  const child = spawn(shim, ["--help"]);
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.match(stdout, /zgap login/);
  assert.match(stdout, /each supported agent's normal local configuration and history/);
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

test("서버 catalog의 중복 slug는 Codex 실행 전에 중단한다", async (t) => {
  await runCatalogFailureScenario(t, {
    serverBody: { models: [{ slug: "anthropic/claude" }, { slug: "anthropic/claude" }] },
    expectedError: /duplicate slug: anthropic\/claude/,
  });
});

test("login은 디바이스 승인 대기와 slow_down을 폴링하고 token pair를 저장한다", async (t) => {
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
  const origin = "https://ai-proxy.zz.gg";
  const requests = [];
  const sleeps = [];
  const logs = [];
  let openUrl;
  const responses = [
    new Response(JSON.stringify({
      device_code: "device-code",
      user_code: "ABCD-EFGH",
      verification_uri: `${origin}/console/cli-auth`,
      verification_uri_complete: `${origin}/console/cli-auth?device_code=device-code&user_code=ABCD-EFGH`,
      expires_in: 600,
      interval: 2,
    }), { status: 200 }),
    new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 }),
    new Response(JSON.stringify({ error: "slow_down" }), { status: 400 }),
    new Response(JSON.stringify({
      access_token: ACCESS_NEW,
      expires_in: 86_400,
      refresh_expires_in: 345_600,
      refresh_token: REFRESH_NEW,
      token_type: "Bearer",
    }), { status: 200 }),
  ];
  const fetchImpl = async (url, options) => {
    requests.push({ url: url.toString(), options, body: JSON.parse(options.body) });
    return responses.shift();
  };

  const { login } = await import("../src/login.mjs");
  await login({
    configDir,
    now: () => Date.parse("2026-08-11T00:00:00.000Z"),
    timeoutMs: 60_000,
    log(message) { logs.push(message); },
    fetchImpl,
    sleep: async (ms) => sleeps.push(ms),
    async openBrowser(url) {
      openUrl = url;
    },
  });

  assert.equal(requests[0].url, `${origin}/cli/oauth/device_authorization`);
  assert.deepEqual(requests[0].body, {
    client_id: "zgap",
    code_challenge: requests[0].body.code_challenge,
    code_challenge_method: "S256",
    device_id: requests[0].body.device_id,
    system_info: requests[0].body.system_info,
  });
  assert.match(requests[0].body.code_challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.match(requests[0].body.device_id, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(requests[0].body.system_info).sort(), ["hostname", "os_arch", "os_name", "os_version"]);
  for (const value of Object.values(requests[0].body.system_info)) {
    assert.equal(typeof value, "string");
    assert.ok(value.length > 0);
    assert.ok(value.length <= 255);
  }
  assert.equal(openUrl, `${origin}/console/cli-auth?device_code=device-code&user_code=ABCD-EFGH`);
  assert.match(logs[0], new RegExp(`${origin}/console/cli-auth\\?device_code=device-code&user_code=ABCD-EFGH`));
  assert.deepEqual(sleeps, [2_000, 2_000, 7_000]);
  assert.equal(requests.length, 4);
  assert.deepEqual(requests[1].body, {
    client_id: "zgap",
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: "device-code",
    code_verifier: requests[1].body.code_verifier,
  });
  assert.match(requests[1].body.code_verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(requests[1].body.client_id, "zgap");
  assert.equal(requests[1].body.grant_type, "urn:ietf:params:oauth:grant-type:device_code");
  assert.equal(requests[1].body.device_code, "device-code");
  assert.equal(requests[1].body.code_verifier, requests[2].body.code_verifier);

  const credentialPath = path.join(configDir, "credentials.json");
  assert.deepEqual(JSON.parse(await readFile(credentialPath, "utf8")), {
    access_expires_at: "2026-08-12T00:00:00.000Z",
    access_token: ACCESS_NEW,
    device_id: requests[0].body.device_id,
    origin,
    refresh_expires_at: "2026-08-15T00:00:00.000Z",
    refresh_token: REFRESH_NEW,
  });
  assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);

  assert.equal(await readFile(path.join(codexHome, "config.toml"), "utf8"), originalCodexConfig);
});

test("login은 설정 origin으로 인증하고 그 origin을 credential에 저장한다", async (t) => {
  const root = await tempDir(t);
  const configDir = path.join(root, "config", "zgap");
  const origin = "https://proxy.example.test";
  const accessToken = jwt("new@example.com", "claude", origin);
  const requests = [];
  let openUrl;
  const responses = [
    new Response(JSON.stringify({
      device_code: "device-code",
      user_code: "ABCD-EFGH",
      verification_uri: `${origin}/console/cli-auth`,
      verification_uri_complete: `${origin}/console/cli-auth?device_code=device-code&user_code=ABCD-EFGH`,
      expires_in: 600,
      interval: 1,
    }), { status: 200 }),
    new Response(JSON.stringify({
      access_token: accessToken,
      expires_in: 86_400,
      refresh_expires_in: 345_600,
      refresh_token: REFRESH_NEW,
      token_type: "Bearer",
    }), { status: 200 }),
  ];

  const { login } = await import("../src/login.mjs");
  await login({
    configDir,
    origin,
    now: () => Date.parse("2026-08-11T00:00:00.000Z"),
    timeoutMs: 60_000,
    log() {},
    fetchImpl: async (url, options) => {
      requests.push({ url: url.toString(), body: JSON.parse(options.body) });
      return responses.shift();
    },
    sleep: async () => {},
    async openBrowser(url) {
      openUrl = url;
    },
  });

  assert.equal(requests[0].url, `${origin}/cli/oauth/device_authorization`);
  assert.equal(requests[1].url, `${origin}/cli/oauth/token`);
  assert.equal(openUrl, `${origin}/console/cli-auth?device_code=device-code&user_code=ABCD-EFGH`);
  assert.deepEqual(JSON.parse(await readFile(path.join(configDir, "credentials.json"), "utf8")), {
    access_expires_at: "2026-08-12T00:00:00.000Z",
    access_token: accessToken,
    device_id: requests[0].body.device_id,
    origin,
    refresh_expires_at: "2026-08-15T00:00:00.000Z",
    refresh_token: REFRESH_NEW,
  });
});

test("login은 origin 인자 없이 config.yml host로 인증한다", async (t) => {
  const root = await tempDir(t);
  const configDir = path.join(root, "config", "zgap");
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, "config.yml"), "host: proxy.example.test\n");
  const origin = "https://proxy.example.test";
  const accessToken = jwt("new@example.com", "claude", origin);
  const requests = [];

  const { login } = await import("../src/login.mjs");
  await login({
    configDir,
    now: () => Date.parse("2026-08-11T00:00:00.000Z"),
    timeoutMs: 60_000,
    log() {},
    fetchImpl: async (url, options) => {
      requests.push({ url: url.toString(), body: JSON.parse(options.body) });
      if (String(url).endsWith("device_authorization")) {
        return new Response(JSON.stringify({
          device_code: "device-code",
          user_code: "ABCD-EFGH",
          verification_uri: `${origin}/console/cli-auth`,
          verification_uri_complete: `${origin}/console/cli-auth?device_code=device-code&user_code=ABCD-EFGH`,
          expires_in: 600,
          interval: 1,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        access_token: accessToken,
        expires_in: 86_400,
        refresh_expires_in: 345_600,
        refresh_token: REFRESH_NEW,
        token_type: "Bearer",
      }), { status: 200 });
    },
    sleep: async () => {},
    openBrowser: async () => {},
  });

  assert.equal(requests[0].url, `${origin}/cli/oauth/device_authorization`);
  assert.equal(JSON.parse(await readFile(path.join(configDir, "credentials.json"), "utf8")).origin, origin);
});

test("login은 잘못된 device authorization 응답을 저장하지 않는다", async (t) => {
  const root = await tempDir(t);
  const configDir = path.join(root, "config", "zgap");
  let opened = false;

  const { login } = await import("../src/login.mjs");
  await assert.rejects(() => login({
    configDir,
    log() {},
    fetchImpl: async () => new Response(JSON.stringify({ device_code: "missing" }), { status: 200 }),
    openBrowser: async () => { opened = true; },
  }), /Device authorization returned an invalid response/);
  assert.equal(opened, false);
  await assert.rejects(access(path.join(configDir, "credentials.json")), { code: "ENOENT" });
});

test("login은 다른 origin의 verification URL을 열지 않는다", async (t) => {
  const root = await tempDir(t);
  const configDir = path.join(root, "config", "zgap");
  let opened = false;

  const { login } = await import("../src/login.mjs");
  await assert.rejects(() => login({
    configDir,
    log() {},
    fetchImpl: async () => new Response(JSON.stringify({
      device_code: "device-code",
      user_code: "ABCD-EFGH",
      verification_uri: "https://attacker.example/console/cli-auth",
      verification_uri_complete: "https://attacker.example/console/cli-auth?device_code=device-code&user_code=ABCD-EFGH",
      expires_in: 600,
      interval: 5,
    }), { status: 200 }),
    openBrowser: async () => { opened = true; },
  }), /Device authorization returned an invalid response/);
  assert.equal(opened, false);
});

test("login은 token 폴링의 terminal error에서 중단한다", async (t) => {
  const root = await tempDir(t);
  const configDir = path.join(root, "config", "zgap");
  const origin = "https://ai-proxy.zz.gg";
  let tokenPolls = 0;

  const { login } = await import("../src/login.mjs");
  await assert.rejects(() => login({
    configDir,
    log() {},
    fetchImpl: async (url) => {
      if (url.pathname.endsWith("device_authorization")) {
        return new Response(JSON.stringify({
          device_code: "device-code",
          user_code: "ABCD-EFGH",
          verification_uri: `${origin}/console/cli-auth`,
          verification_uri_complete: `${origin}/console/cli-auth?device_code=device-code&user_code=ABCD-EFGH`,
          expires_in: 600,
          interval: 1,
        }), { status: 200 });
      }
      tokenPolls += 1;
      return new Response(JSON.stringify({ error: "access_denied" }), { status: 400 });
    },
    sleep: async () => {},
    openBrowser: async () => {},
  }), /Token authorization failed: access_denied/);
  assert.equal(tokenPolls, 1);
});

test("login timeout 이후에는 늦은 성공 응답을 credential로 저장하지 않는다", async (t) => {
  const root = await tempDir(t);
  const configDir = path.join(root, "config", "zgap");
  const origin = "https://ai-proxy.zz.gg";
  const { login } = await import("../src/login.mjs");
  await assert.rejects(() => login({
    configDir,
    timeoutMs: 5,
    log() {},
    fetchImpl: async (url) => new Response(JSON.stringify(
      url.pathname.endsWith("device_authorization")
        ? {
            device_code: "device-code",
            user_code: "ABCD-EFGH",
            verification_uri: `${origin}/console/cli-auth`,
            verification_uri_complete: `${origin}/console/cli-auth?device_code=device-code&user_code=ABCD-EFGH`,
            expires_in: 600,
            interval: 1,
          }
        : {
            access_token: ACCESS_NEW,
            expires_in: 86_400,
            refresh_expires_in: 345_600,
            refresh_token: REFRESH_NEW,
            token_type: "Bearer",
          }
    ), { status: 200 }),
    openBrowser: async () => {},
    sleep: async () => new Promise((resolve) => setTimeout(resolve, 20)),
  }), /Login timed out/);
  await delay(30);
  await assert.rejects(access(path.join(configDir, "credentials.json")), { code: "ENOENT" });
});

test("login은 browser launcher가 멈춰도 전체 timeout에 종료한다", async (t) => {
  const root = await tempDir(t);
  const origin = "https://ai-proxy.zz.gg";
  const { login } = await import("../src/login.mjs");

  await assert.rejects(() => login({
    configDir: path.join(root, "config", "zgap"),
    timeoutMs: 5,
    log() {},
    fetchImpl: async () => new Response(JSON.stringify({
      device_code: "device-code",
      user_code: "ABCD-EFGH",
      verification_uri: `${origin}/console/cli-auth`,
      verification_uri_complete: `${origin}/console/cli-auth?device_code=device-code&user_code=ABCD-EFGH`,
      expires_in: 600,
      interval: 5,
    }), { status: 200 }),
    openBrowser: async () => new Promise(() => {}),
  }), /Login timed out/);
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
  const origin = "https://proxy.example.test";
  const accessToken = jwt("old@example.com", "codex", origin);
  const gateway = createServer(async (request, response) => {
    modelRequest = { authorization: request.headers.authorization, url: request.url };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      models: [
        { slug: "openai/gpt-5.6-luna" },
        { slug: "anthropic/claude" },
      ],
    }));
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  t.after(() => gateway.close());
  const fetchRedirectModule = await installGatewayFetchRedirect(t, gateway.address().port, [origin]);
  await writeFile(path.join(configDir, "config.yml"), "host: proxy.example.test\n");
  await writeFile(path.join(configDir, "preferences.json"), '{"dangerousMode":true}\n');
  await writeFile(path.join(configDir, "credentials.json"), JSON.stringify({
    access_expires_at: "2099-01-02T00:00:00.000Z",
    access_token: accessToken,
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

  const cliEnv = {
    HOME: home,
    XDG_CONFIG_HOME: configRoot,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    CODEX_HOME: path.join(root, "separate-codex-home"),
    OPENAI_BASE_URL: "https://wrong.example",
    NODE_OPTIONS: `--import=${fetchRedirectModule}`,
  };
  const result = await runCli(["codex", "exec", "hello"], cliEnv);
  assert.equal(result.code, 0, result.stderr);
  const invocation = JSON.parse(result.stdout);
  assert.equal(invocation.codexHome, null);
  assert.equal(invocation.openaiBaseUrl, null);
  assert.equal(invocation.openaiApiKey, null);
  assert.equal(invocation.zgapApiKey, null);
  assert.equal(invocation.argv.includes("--dangerously-bypass-approvals-and-sandbox"), true);
  assert.deepEqual(invocation.argv.slice(-2), ["exec", "hello"]);
  assert.deepEqual(modelRequest, {
    authorization: `Bearer ${accessToken}`,
    url: "/v1/models?client_version=9.8.7",
  });

  const joined = invocation.argv.join("\n");
  assert.match(joined, /model_provider="zgap"/);
  assert.match(joined, /model_providers\.zgap=\{name="zgap",base_url="https:\/\/proxy\.example\.test\/v1"/);
  assert.match(joined, /auth=\{command=/);
  assert.match(joined, /auth-token/);
  assert.match(joined, new RegExp(credentialPathPattern(path.join(configDir, "credentials.json"))));
  assert.equal(joined.includes(accessToken), false);
  assert.equal(joined.includes(REFRESH_OLD), false);
  assert.equal(invocation.argv.includes("--profile"), false);
  const modelCatalog = joined.match(/model_catalog_json=("[^"]+")/)?.[1];
  assert.ok(modelCatalog);
  assert.match(JSON.parse(modelCatalog), new RegExp(`${path.sep}zgap-[^${path.sep}]+${path.sep}catalog\\.json$`));
  assert.deepEqual(invocation.catalog.models, [
    { slug: "openai/gpt-5.6-luna" },
    { slug: "anthropic/claude" },
  ]);
  assert.equal(invocation.catalogMode, 0o600);
  assert.equal(invocation.catalogDirectoryMode, 0o700);
  await assert.rejects(access(JSON.parse(modelCatalog)), { code: "ENOENT" });
  await assert.rejects(access(path.join(configDir, "models.json")), { code: "ENOENT" });
  await assert.rejects(access(path.join(home, ".codex")), { code: "ENOENT" });

  await writeFile(path.join(configDir, "preferences.json"), '{"dangerousMode":false}\n');
  const safeResult = await runCli(["codex", "exec", "hello"], cliEnv);
  assert.equal(safeResult.code, 0, safeResult.stderr);
  assert.equal(JSON.parse(safeResult.stdout).argv.includes("--dangerously-bypass-approvals-and-sandbox"), false);
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
      models: [{ slug: "openai/gpt-5.6-luna" }],
    }));
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  t.after(() => gateway.close());
  const fetchRedirectModule = await installGatewayFetchRedirect(t, gateway.address().port);
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
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("codex-cli 1.0.0\\n");
else {
  const catalogPath = JSON.parse(args.find((arg) => arg.startsWith("model_catalog_json=")).slice("model_catalog_json=".length));
  writeFileSync(process.env.FAKE_CODEX_SIGNAL_MARKER, JSON.stringify({ pid: process.pid, catalogPath, catalog: readFileSync(catalogPath, "utf8") }));
  setInterval(() => {}, 1_000);
}
`);
  await chmod(fakeCodex, 0o755);

  const wrapper = spawn(nodePath, [cliPath, "codex"], {
    env: {
      HOME: home,
      XDG_CONFIG_HOME: configRoot,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      FAKE_CODEX_SIGNAL_MARKER: marker,
      NODE_OPTIONS: `--import=${fetchRedirectModule}`,
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
      models: [{ slug: "openai/gpt-5.6-luna" }],
    }));
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  t.after(() => gateway.close());
  const origin = "https://ai-proxy.zz.gg";
  const fetchRedirectModule = await installGatewayFetchRedirect(t, gateway.address().port);
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
else writeFileSync(process.env.FAKE_CODEX_MARKER, "ran");
`);
  await chmod(fakeCodex, 0o755);

  const result = await runCli(["codex"], {
    HOME: home,
    XDG_CONFIG_HOME: configRoot,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    FAKE_CODEX_MARKER: codexMarker,
    NODE_OPTIONS: `--import=${fetchRedirectModule}`,
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
  await writeFile(path.join(configDir, "config.yml"), "host: proxy.example.test\n");
  await writeFile(path.join(configDir, "preferences.json"), '{"dangerousMode":true}\n');
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
  const cliEnv = { HOME: home, XDG_CONFIG_HOME: configRoot, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, FAKE_CLAUDE_MARKER: marker, ANTHROPIC_BASE_URL: "https://wrong.example", ANTHROPIC_API_KEY: "wrong-key", ANTHROPIC_AUTH_TOKEN: "wrong-token", ANTHROPIC_FOUNDRY_API_KEY: "wrong-key", CLAUDE_CODE_API_BASE_URL: "https://wrong.example", CLAUDE_CODE_PROXY_URL: "https://wrong.example", CLAUDE_CODE_SESSION_ACCESS_TOKEN: "wrong-token", CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CONFIG_DIR: path.join(root, "wrong-claude") };
  const result = await runCli(["claude", "--print", "hello"], cliEnv);
  assert.equal(result.code, 7, result.stderr);
  const invocation = JSON.parse(await readFile(marker, "utf8"));
  assert.equal(invocation.argv.includes("--dangerously-skip-permissions"), true);
  assert.deepEqual(invocation.argv.slice(-2), ["--print", "hello"]);
  const settingsIndex = invocation.argv.indexOf("--settings");
  assert.ok(settingsIndex >= 0);
  const settings = JSON.parse(invocation.argv[settingsIndex + 1]);
  assert.match(settings.apiKeyHelper, /auth-token/);
  assert.match(settings.apiKeyHelper, /credentials\.json/);
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://proxy.example.test");
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
  assert.equal(invocation.env.ANTHROPIC_BASE_URL, "https://proxy.example.test");
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

  await writeFile(path.join(configDir, "preferences.json"), '{"dangerousMode":false}\n');
  const safeResult = await runCli(["claude", "--print", "hello"], cliEnv);
  assert.equal(safeResult.code, 7, safeResult.stderr);
  assert.equal(JSON.parse(await readFile(marker, "utf8")).argv.includes("--dangerously-skip-permissions"), false);
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

test("omp는 정적 extension과 사용자 OMP 설정을 그대로 넘긴다", async (t) => {
  const root = await tempDir(t);
  const home = path.join(root, "home");
  const configRoot = path.join(root, "config");
  const configDir = path.join(configRoot, "zgap");
  const fakeBin = path.join(root, "bin");
  await mkdir(configDir, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  const origin = "https://proxy.example.test";
  const accessToken = jwt("old@example.com", "codex", origin);
  await writeFile(path.join(configDir, "config.yml"), "host: proxy.example.test\n");
  await writeFile(path.join(configDir, "credentials.json"), JSON.stringify({
    access_expires_at: "2099-01-02T00:00:00.000Z",
    access_token: accessToken,
    device_id: "d".repeat(43),
    origin,
    refresh_expires_at: "2099-01-05T00:00:00.000Z",
    refresh_token: REFRESH_OLD,
  }), { mode: 0o600 });
  await writeFile(path.join(configDir, "preferences.json"), '{"dangerousMode":true}\n');

  const fakeOmp = path.join(fakeBin, "omp");
  await writeFile(fakeOmp, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("omp/18.0.3\\n"); process.exit(0); }
process.stdout.write(JSON.stringify({
  argv: args,
  env: Object.fromEntries(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "ZGAP_API_KEY", "PI_CODEX_WEBSOCKET", "HOME", "OMP_PROFILE", "PI_CONFIG_DIR"].map((key) => [key, process.env[key] ?? null])),
}));
process.exitCode = 5;
`);
  await chmod(fakeOmp, 0o755);

  const cliEnv = {
    HOME: home,
    XDG_CONFIG_HOME: configRoot,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    ANTHROPIC_API_KEY: "user-anthropic-key",
    ANTHROPIC_BASE_URL: "https://user-anthropic.example",
    OPENAI_API_KEY: "user-openai-key",
    OPENAI_BASE_URL: "https://user-openai.example",
    ZGAP_API_KEY: "user-zgap-key",
    PI_CODEX_WEBSOCKET: "0",
    OMP_PROFILE: "work",
    PI_CONFIG_DIR: path.join(root, "omp-config"),
  };
  const result = await runCli(["omp", "--print", "hello"], cliEnv);
  assert.equal(result.code, 5, result.stderr);
  const invocation = JSON.parse(result.stdout);
  assert.equal(invocation.argv[0], "--trusted-extension");
  assert.equal(invocation.argv.filter((arg) => arg === "--trusted-extension").length, 1);
  assert.equal(invocation.argv.includes("-e"), false);
  assert.equal(invocation.argv.includes("--config"), false);
  assert.equal(invocation.argv.includes("--model"), false);
  assert.equal(invocation.argv.includes("--auto-approve"), true);
  assert.deepEqual(invocation.argv.slice(-2), ["--print", "hello"]);
  const extensionPath = invocation.argv[1];
  const shippedExtensionPath = path.join(repoDir, "src", "omp-provider-extension.mjs");
  assert.equal(await realpath(extensionPath), await realpath(shippedExtensionPath));
  assert.ok((await readFile(extensionPath, "utf8")).length > 0);
  assert.deepEqual(invocation.env, {
    ANTHROPIC_API_KEY: "user-anthropic-key",
    ANTHROPIC_BASE_URL: "https://user-anthropic.example",
    OPENAI_API_KEY: "user-openai-key",
    OPENAI_BASE_URL: "https://user-openai.example",
    ZGAP_API_KEY: "user-zgap-key",
    PI_CODEX_WEBSOCKET: "0",
    HOME: home,
    OMP_PROFILE: "work",
    PI_CONFIG_DIR: path.join(root, "omp-config"),
  });

  const explicitModeResult = await runCli(["omp", "--approval-mode", "always-ask", "--print", "hello"], cliEnv);
  assert.equal(explicitModeResult.code, 5, explicitModeResult.stderr);
  const explicitModeInvocation = JSON.parse(explicitModeResult.stdout);
  assert.equal(explicitModeInvocation.argv.includes("--auto-approve"), false);
  assert.deepEqual(explicitModeInvocation.argv.slice(-4), ["--approval-mode", "always-ask", "--print", "hello"]);

  await writeFile(path.join(configDir, "preferences.json"), '{"dangerousMode":false}\n');
  const safeResult = await runCli(["omp", "--print", "hello"], cliEnv);
  assert.equal(safeResult.code, 5, safeResult.stderr);
  assert.equal(JSON.parse(safeResult.stdout).argv.includes("--auto-approve"), false);
});

test("OMP extension은 기존 OpenAI와 Anthropic provider를 proxy로 재등록한다", async () => {
  const { authTokenCommand, registerProxyProviders } = await import("../src/omp-provider-extension.mjs");
  const registrations = [];
  const origin = "https://proxy.example.test";
  const credentialFile = "/tmp/zgap credentials.json";
  const env = {
    CLAUDE_CODE_USE_FOUNDRY: "1",
    FOUNDRY_BASE_URL: "https://foundry.example",
    ANTHROPIC_CUSTOM_HEADERS: "x-tenant: keep, Authorization: Bearer wrong\nX-Api-Key: wrong",
    PRESERVED: "yes",
  };
  await registerProxyProviders({
    registerProvider(name, config) {
      registrations.push({ name, config });
    },
  }, { origin, credentialFile, platform: "linux", env });

  assert.deepEqual(registrations.map(({ name }) => name), ["openai-codex", "anthropic"]);
  const openai = registrations[0].config;
  const anthropic = registrations[1].config;
  assert.equal(openai.baseUrl, `${origin}/v1/responses?omp_endpoint=/codex/responses`);
  assert.equal(anthropic.baseUrl, origin);
  const expectedKey = authTokenCommand(credentialFile, "linux");
  assert.match(expectedKey, /^!/);
  assert.match(expectedKey, /auth-token/);
  assert.equal(openai.apiKey, expectedKey);
  assert.equal(anthropic.apiKey, expectedKey);
  assert.equal(anthropic.authHeader, true);
  assert.equal(anthropic.headers["X-Api-Key"], expectedKey);
  assert.deepEqual(env, {
    ANTHROPIC_CUSTOM_HEADERS: "x-tenant: keep",
    PRESERVED: "yes",
  });

  for (const { name, config } of registrations) {
    assert.equal(Object.hasOwn(config, "models"), false);
    assert.equal(config.usage.id, name);
    assert.equal(config.usage.supports({ provider: name, credential: { type: "oauth", accessToken: "unused" } }), false);
    assert.equal(config.usage.supports({ provider: name, credential: { type: "api_key", apiKey: "unused" } }), false);
    assert.equal(await config.usage.fetchUsage(
      { provider: name, credential: { type: "api_key", apiKey: "unused" } },
      { fetch: async () => { throw new Error("official usage endpoint must not be called"); } },
    ), null);
  }
});

test("omp Windows auth helper는 경로를 PowerShell encoded command로 전달한다", async () => {
  const { authTokenCommand } = await import("../src/omp-provider-extension.mjs");
  const credentialFile = "C:\\Users\\O'Neil\\%TOKEN%\\credentials.json";
  const command = authTokenCommand(credentialFile, "win32");
  const encoded = command.split(" ").at(-1);
  const script = Buffer.from(encoded, "base64").toString("utf16le");

  assert.match(command, /^!powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand /);
  assert.match(script, / 'auth-token' /);
  assert.match(script, /'C:\\Users\\O''Neil\\%TOKEN%\\credentials\.json'/);
  assert.match(script, /\nexit \$LASTEXITCODE$/);
});

test("omp는 18.0.3보다 오래된 버전을 실행 전에 거부한다", async (t) => {
  const root = await tempDir(t);
  const configRoot = path.join(root, "config");
  const configDir = path.join(configRoot, "zgap");
  const fakeBin = path.join(root, "bin");
  const marker = path.join(root, "normal-invocation");
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
  const fakeOmp = path.join(fakeBin, "omp");
  await writeFile(fakeOmp, `#!/usr/bin/env node
if (process.argv[2] === "--version") { process.stdout.write(\`omp/\${process.env.FAKE_OMP_VERSION}\\n\`); process.exit(0); }
import("node:fs").then(({ writeFileSync }) => writeFileSync(${JSON.stringify(marker)}, "ran"));
`);
  await chmod(fakeOmp, 0o755);

  for (const version of ["18.0.2", "18.0.3-rc.1"]) {
    const result = await runCli(["omp"], {
      XDG_CONFIG_HOME: configRoot,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      FAKE_OMP_VERSION: version,
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /18\.0\.3/);
    await assert.rejects(access(marker), { code: "ENOENT" });
  }
});

test("omp standalone usage는 공식 provider 조회 전에 거부한다", async (t) => {
  const root = await tempDir(t);
  const configRoot = path.join(root, "config");
  const configDir = path.join(configRoot, "zgap");
  const fakeBin = path.join(root, "bin");
  const marker = path.join(root, "ran");
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
  await writeFile(path.join(fakeBin, "omp"), `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "ran");
`);
  await chmod(path.join(fakeBin, "omp"), 0o755);

  const result = await runCli(["omp", "--cwd", ".", "usage", "--json"], {
    XDG_CONFIG_HOME: configRoot,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /usage.*disabled/i);
  await assert.rejects(access(marker), { code: "ENOENT" });
});

test("omp는 로그인 전이면 OMP 확인도 하지 않고 login 안내를 반환한다", async (t) => {
  const root = await tempDir(t);
  const configRoot = path.join(root, "config");
  const fakeBin = path.join(root, "bin");
  await mkdir(path.join(configRoot, "zgap"), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  const marker = path.join(root, "ran");
  const fakeOmp = path.join(fakeBin, "omp");
  await writeFile(fakeOmp, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "ran");
if (process.argv[2] === "--version") { process.stdout.write("omp/18.0.3\\n"); process.exit(0); }
`);
  await chmod(fakeOmp, 0o755);
  const result = await runCli(["omp"], {
    XDG_CONFIG_HOME: configRoot,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Not logged in\. Run `zgap login` first\./);
  await assert.rejects(access(marker), { code: "ENOENT" });
});

test("omp가 PATH에 없으면 명확한 오류를 반환한다", async () => {
  const result = await runCli(["omp"], { PATH: "" });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /OMP CLI is not installed or not in PATH/);
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
    access_expires_at: "2026-08-11T03:59:00.000Z",
    access_token: ACCESS_OLD,
    device_id: "d".repeat(43),
    origin: "https://ai-proxy.zz.gg",
    refresh_expires_at: "2026-08-14T00:00:00.000Z",
    refresh_token: REFRESH_OLD,
  }), { mode: 0o600 });
  let refreshCalls = 0;
  const fetchImpl = async (url, options) => {
    refreshCalls += 1;
    assert.equal(url.toString(), "https://ai-proxy.zz.gg/cli/oauth/token");
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
  assert.equal(saved.origin, "https://ai-proxy.zz.gg");
  assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
});

test("auth-token은 credential origin으로 refresh한다", async (t) => {
  const root = await tempDir(t);
  const origin = "https://proxy.example.test";
  const accessOld = jwt("old@example.com", "codex", origin);
  const accessNew = jwt("new@example.com", "claude", origin);
  const credentialPath = path.join(root, "credentials.json");
  await writeFile(credentialPath, JSON.stringify({
    access_expires_at: "2026-08-11T03:59:00.000Z",
    access_token: accessOld,
    device_id: "d".repeat(43),
    origin,
    refresh_expires_at: "2026-08-14T00:00:00.000Z",
    refresh_token: REFRESH_OLD,
  }), { mode: 0o600 });
  const refreshUrls = [];
  const { resolveAccessToken } = await import("../src/credentials.mjs");

  const token = await resolveAccessToken({
    credentialFile: credentialPath,
    now: () => Date.parse("2026-08-11T00:00:00.000Z"),
    fetchImpl: async (url) => {
      refreshUrls.push(url.toString());
      return new Response(JSON.stringify({
        access_token: accessNew,
        expires_in: 86_400,
        refresh_expires_in: 345_600,
        refresh_token: REFRESH_NEW,
        token_type: "Bearer",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(token, accessNew);
  assert.deepEqual(refreshUrls, [`${origin}/cli/oauth/token`]);
  assert.equal(JSON.parse(await readFile(credentialPath, "utf8")).origin, origin);
});

test("auth-token은 15분 넘게 남은 access를 network와 5xx refresh 실패 중에도 사용한다", async (t) => {
  const root = await tempDir(t);
  const { resolveAccessToken } = await import("../src/credentials.mjs");
  for (const [name, fetchImpl] of [
    ["network", async () => { throw new Error("offline"); }],
    ["5xx", async () => new Response("unavailable", { status: 503 })],
  ]) {
    const credentialPath = path.join(root, `${name}.json`);
    await writeFile(credentialPath, JSON.stringify({
      access_expires_at: "2026-08-11T02:00:00.000Z",
      access_token: ACCESS_OLD,
      device_id: "d".repeat(43),
      origin: "https://ai-proxy.zz.gg",
      refresh_expires_at: "2026-08-14T00:00:00.000Z",
      refresh_token: REFRESH_OLD,
    }), { mode: 0o600 });
    let refreshCalls = 0;

    const token = await resolveAccessToken({
      credentialFile: credentialPath,
      now: () => Date.parse("2026-08-11T00:00:00.000Z"),
      fetchImpl: async (...args) => {
        refreshCalls += 1;
        return fetchImpl(...args);
      },
    });

    assert.equal(token, ACCESS_OLD);
    assert.equal(refreshCalls, 1);
  }
});

test("auth-token은 access가 15분 이내이면 5xx refresh 실패를 반환한다", async (t) => {
  const root = await tempDir(t);
  const credentialPath = path.join(root, "credentials.json");
  await writeFile(credentialPath, JSON.stringify({
    access_expires_at: "2026-08-11T00:15:00.000Z",
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
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
    }),
    (error) => error?.message === "Token refresh failed (503).",
  );
});

test("auth-token은 access가 남아 있어도 4xx refresh 실패를 반환한다", async (t) => {
  const root = await tempDir(t);
  const credentialPath = path.join(root, "credentials.json");
  await writeFile(credentialPath, JSON.stringify({
    access_expires_at: "2026-08-11T02:00:00.000Z",
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
      fetchImpl: async () => new Response('{"error":"invalid_grant"}', { status: 401 }),
    }),
    (error) => error?.message === "Token refresh failed (401). Run `zgap login` again.",
  );
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
