import assert from "node:assert/strict";
import { test } from "./harness.mjs";

test("인자 없는 CLI는 자동 업데이트 확인을 기다리지 않고 시작 메뉴에 전달한다", async () => {
  const { main } = await import("../src/cli.mjs");
  let resolveUpdate;
  const pendingUpdate = new Promise((resolve) => { resolveUpdate = resolve; });
  let menuOptions;
  let updateCalls = 0;

  const result = await main({
    argv: [],
    configDir: "/tmp/zgap-config",
    credentialStateReader: async () => "signed-out",
    updateChecker: () => {
      updateCalls += 1;
      return pendingUpdate;
    },
    startMenu: async (options) => {
      menuOptions = options;
      return 23;
    },
  });

  assert.equal(result, 23);
  assert.equal(updateCalls, 0);
  const updatePromise = menuOptions.updateChecker();
  assert.equal(updateCalls, 1);
  resolveUpdate({ state: "current" });
  assert.deepEqual(await updatePromise, { state: "current" });
});

test("직접 명령은 자동 업데이트 확인을 시작하지 않는다", async () => {
  const { main } = await import("../src/cli.mjs");
  let updateCalls = 0;

  const result = await main({
    argv: ["help"],
    updateChecker: () => {
      updateCalls += 1;
      return Promise.resolve({ state: "current" });
    },
  });

  assert.equal(result, 0);
  assert.equal(updateCalls, 0);
});
