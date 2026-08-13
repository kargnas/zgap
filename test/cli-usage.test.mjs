import assert from "node:assert/strict";
import { test } from "node:test";

test("인자 없는 로그인 CLI는 본인 사용량 조회를 기다리지 않고 TUI에 전달한다", async () => {
  const { main } = await import("../src/cli.mjs");
  let usageRequest;
  let resolveUsage;
  const pendingUsage = new Promise((resolve) => { resolveUsage = resolve; });
  let menuOptions;

  const result = await main({
    argv: [],
    configDir: "/tmp/zgap-config",
    credentialStateReader: async () => "signed-in",
    usageReader: (options) => {
      usageRequest = options;
      return pendingUsage;
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
  assert.deepEqual(usageRequest, { credentialFile: "/tmp/zgap-config/credentials.json" });
  const expectedUsage = { plan_type: "ai-proxy1" };
  resolveUsage(expectedUsage);
  assert.deepEqual(await menuOptions.usagePromise, expectedUsage);
});

test("미로그인 CLI는 본인 사용량을 요청하지 않는다", async () => {
  const { main } = await import("../src/cli.mjs");
  let usageCalls = 0;
  let menuOptions;

  await main({
    argv: [],
    configDir: "/tmp/zgap-config",
    credentialStateReader: async () => "signed-out",
    usageReader: async () => { usageCalls += 1; },
    startMenu: async (options) => {
      menuOptions = options;
      return 0;
    },
    entryPath: "/tmp/zgap",
    invokedPath: "/tmp/zgap",
    modulePath: "/tmp/zgap",
  });

  assert.equal(usageCalls, 0);
  assert.equal(menuOptions.usagePromise, undefined);
});

test("본인 사용량 조회 실패는 TUI가 표시할 unavailable 상태로 변환한다", async () => {
  const { main } = await import("../src/cli.mjs");
  let menuOptions;

  await main({
    argv: [],
    configDir: "/tmp/zgap-config",
    credentialStateReader: async () => "signed-in",
    usageReader: async () => { throw new Error("offline"); },
    startMenu: async (options) => {
      menuOptions = options;
      return 0;
    },
    entryPath: "/tmp/zgap",
    invokedPath: "/tmp/zgap",
    modulePath: "/tmp/zgap",
  });

  assert.equal(await menuOptions.usagePromise, null);
});

test("인자 없는 로그인 CLI는 JWT 계정 프로필을 메뉴에 전달한다", async () => {
  const { main } = await import("../src/cli.mjs");
  let menuOptions;
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = [encode({ alg: "EdDSA", typ: "JWT" }), encode({ iss: "https://ai-proxy.zz.gg", aud: ["https://ai-proxy.zz.gg"], sub: "1", sid: "2", email: "user@example.com", email_verified: false, iat: 1, exp: 2, proxy_products: [{ id: "codex", origin: "https://ai-proxy.zz.gg" }] }), "signature"].join(".");
  await main({
    argv: [],
    configDir: "/tmp/zgap-config",
    credentialStateReader: async () => "signed-in",
    credentialReader: async () => ({ access_token: token }),
    usageReader: async () => null,
    startMenu: async (options) => { menuOptions = options; return 0; },
    entryPath: "/tmp/zgap",
    invokedPath: "/tmp/zgap",
    modulePath: "/tmp/zgap",
  });
  assert.deepEqual(menuOptions.accountProfile, { email: "user@example.com", emailVerified: false, proxyProducts: [{ id: "codex", origin: "https://ai-proxy.zz.gg" }] });
  assert.equal(menuOptions.credentialState, "signed-in");
  // The real credential read is intentionally isolated from this dependency-injected CLI test.
  assert.equal(typeof menuOptions.usagePromise.then, "function");
});
