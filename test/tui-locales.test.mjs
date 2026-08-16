import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "./harness.mjs";
import { fileURLToPath } from "node:url";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function flushMenu(setup) {
  await new Promise((resolve) => setTimeout(resolve, 25));
  await setup.renderOnce();
}

test("영어와 한국어 locale은 같은 메뉴 key를 제공하고 40x10에서 primary action을 유지한다", async (t) => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { runStartMenu } = await import("../src/tui/menu.mjs");
  const locales = [
    ["en", [["signed-in", "user@example.com", "CODEX"], ["expired", "Session expired", "Login again"], ["signed-out", "Not signed in", "Login"]]],
    ["ko", [["signed-in", "user@example.com", "CODEX"], ["expired", "세션 만료", "다시 로그인"], ["signed-out", "로그인 필요", "로그인"]]],
  ];
  const localeDir = path.join(repoDir, "src", "tui", "locales");
  assert.deepEqual((await readdir(localeDir)).sort(), ["en.json", "ko.json"]);
  const englishKeys = Object.keys(JSON.parse(await readFile(path.join(localeDir, "en.json"), "utf8"))).sort();

  for (const [locale, states] of locales) {
    const keys = Object.keys(JSON.parse(await readFile(path.join(localeDir, `${locale}.json`), "utf8"))).sort();
    assert.deepEqual(keys, englishKeys, `${locale} menu keys differ`);
    for (const [credentialState, status, action] of states) {
      const setup = await createTestRenderer({ width: 40, height: 10 });
      t.after(() => setup.renderer.destroy());
      const resultPromise = runStartMenu({
        rendererFactory: async () => setup,
        credentialState,
        accountProfile: credentialState === "signed-in" ? { email: "user@example.com" } : undefined,
        language: locale,
        proxyHealthCheck: async () => ({ state: "online", latencyMs: 85 }),
        actions: { login: async () => 0, codex: async () => 0 },
      });
      await flushMenu(setup);
      const frame = setup.captureCharFrame();
      const proxyStatus = locale === "ko" ? "프록시 접속됨" : "Proxy online";
      assert.match(frame, new RegExp(status), `${locale} ${credentialState} status clipped`);
      assert.match(frame, new RegExp(action), `${locale} ${credentialState} action clipped`);
      if (credentialState === "signed-in") {
        assert.match(frame, /Claude/, `${locale} Claude action clipped`);
        assert.doesNotMatch(frame, /Signed in|로그인됨/, `${locale} legacy status remains`);
      }
      assert.match(frame, new RegExp(proxyStatus), `${locale} ${credentialState} proxy status clipped`);
      assert.match(frame, /85 ms/, `${locale} ${credentialState} proxy latency clipped`);
      assert.match(frame, /Esc/, `${locale} ${credentialState} quit hint clipped`);
      await setup.mockInput.pressCtrlC();
      await setup.mockInput.pressCtrlC();
      assert.equal(await resultPromise, 130);
    }
  }
});
