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
    credentialReader: async () => ({ access_token: token }),
    updateChecker: async () => ({ state: "skipped" }),
    startMenu: async (options) => { menuOptions = options; return 0; },
  });

  assert.equal(menuOptions.accountProfile.email, "user@example.com");
  assert.equal(menuOptions.credentialState, "signed-in");
});
