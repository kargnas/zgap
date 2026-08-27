import assert from "node:assert/strict";
import { test } from "./harness.mjs";

test("인자 없는 로그인 CLI는 JWT의 이메일을 메뉴에 전달한다", async () => {
  const { main } = await import("../src/cli.mjs");
  let menuOptions;
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = [
    encode({ alg: "EdDSA", typ: "JWT" }),
    encode({
      iss: "https://ai-proxy.zz.gg",
      aud: ["https://ai-proxy.zz.gg"],
      sub: "1",
      sid: "2",
      email: "user@example.com",
      email_verified: false,
      iat: 1,
      exp: 2,
      proxy_products: [{ id: "codex", origin: "https://ai-proxy.zz.gg" }],
    }),
    "sig",
  ].join(".");

  await main({
    argv: [],
    configDir: "/tmp/zgap-config",
    credentialStateReader: async () => "signed-in",
    credentialReader: async () => ({ access_token: token, origin: "https://ai-proxy.zz.gg" }),
    updateChecker: async () => ({ state: "skipped" }),
    startMenu: async (options) => { menuOptions = options; return 0; },
  });

  assert.equal(menuOptions.accountProfile.email, "user@example.com");
  assert.equal(menuOptions.credentialState, "signed-in");
});

test("정적 API key 상태는 JWT profile을 읽지 않고 메뉴에 전달한다", async () => {
  const { main } = await import("../src/cli.mjs");
  let menuOptions;

  await main({
    argv: [],
    configDir: "/tmp/zgap-config",
    credentialStateReader: async () => "api-key",
    credentialReader: async () => { throw new Error("API key must not be decoded as JWT"); },
    updateChecker: async () => ({ state: "skipped" }),
    startMenu: async (options) => { menuOptions = options; return 0; },
  });

  assert.equal(menuOptions.credentialState, "api-key");
  assert.equal(menuOptions.accountProfile, undefined);
});

test("login api는 선택 메뉴 없이 API key를 바로 저장한다", async () => {
  const { main } = await import("../src/cli.mjs");
  const calls = [];
  const result = await main({
    argv: ["login", "api"],
    configDir: "/tmp/zgap-config",
    configReader: async () => { throw new Error("API login must not load OAuth configuration"); },
    loginMenu: async () => { throw new Error("Explicit API login must not open the selector"); },
    apiKeyReader: async () => "sk-test-static-key",
    apiKeySaver: async (options) => { calls.push(options); },
    log: (message) => { calls.push(message); },
  });

  assert.equal(result, 0);
  assert.deepEqual(calls, [
    { configDir: "/tmp/zgap-config", apiKey: "sk-test-static-key" },
    "Static API key configured.",
  ]);
});

test("login oauth는 선택 메뉴 없이 OAuth 로그인을 바로 시작한다", async () => {
  const { main } = await import("../src/cli.mjs");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Unexpected real OAuth request"); };
  let loginOptions;
  try {
    const result = await main({
      argv: ["login", "oauth"],
      configDir: "/tmp/zgap-config",
      configReader: async () => ({ origin: "https://proxy.example.test" }),
      loginMenu: async () => { throw new Error("Explicit OAuth login must not open the selector"); },
      loginRunner: async (options) => { loginOptions = options; },
    });
    assert.equal(result, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(loginOptions, {
    configDir: "/tmp/zgap-config",
    origin: "https://proxy.example.test",
  });
});

test("인자 없는 login은 인증 방식을 선택한 뒤 해당 흐름을 시작한다", async () => {
  const { main } = await import("../src/cli.mjs");
  let selected = false;
  let saved;
  let loginMenuOptions;
  const result = await main({
    argv: ["login"],
    configDir: "/tmp/zgap-config",
    configReader: async () => ({ host: "custom.example.test", origin: "https://custom.example.test" }),
    loginMenu: async (options) => { selected = true; loginMenuOptions = options; return "api"; },
    apiKeyReader: async () => "sk-test-static-key",
    apiKeySaver: async (options) => { saved = options; },
    log: () => {},
  });

  assert.equal(result, 0);
  assert.equal(selected, true);
  assert.deepEqual(loginMenuOptions, {
    host: "custom.example.test",
    origin: "https://custom.example.test",
  });
  assert.deepEqual(saved, { configDir: "/tmp/zgap-config", apiKey: "sk-test-static-key" });
});

test("시작 메뉴의 login action도 인증 방식 선택 화면을 사용한다", async () => {
  const { main } = await import("../src/cli.mjs");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Unexpected real OAuth request"); };
  let saved;
  let loginMenuOptions;
  try {
    const result = await main({
      argv: [],
      configDir: "/tmp/zgap-config",
      credentialStateReader: async () => "signed-out",
      configReader: async () => ({ host: "proxy.example.test", origin: "https://proxy.example.test" }),
      updateChecker: async () => ({ state: "skipped" }),
      startMenu: async ({ actions }) => actions.login(),
      loginMenu: async (options) => { loginMenuOptions = options; return "api"; },
      apiKeyReader: async () => "sk-test-static-key",
      apiKeySaver: async (options) => { saved = options; },
      log: () => {},
    });
    assert.equal(result, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(saved, { configDir: "/tmp/zgap-config", apiKey: "sk-test-static-key" });
  assert.deepEqual(loginMenuOptions, {
    host: "proxy.example.test",
    origin: "https://proxy.example.test",
  });
});
