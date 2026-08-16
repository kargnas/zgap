import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "./harness.mjs";

async function tempDir(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zgap-config-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("config.yml host는 agent proxy origin으로 정규화된다", async (t) => {
  const configDir = await tempDir(t);
  await writeFile(path.join(configDir, "config.yml"), "host: Proxy.Example.Test\n");
  const { readProxyConfig } = await import("../src/config.mjs");

  assert.deepEqual(await readProxyConfig(configDir), {
    host: "proxy.example.test",
    origin: "https://proxy.example.test",
  });
});

test("config.yml이 없으면 기본 host를 사용한다", async (t) => {
  const configDir = await tempDir(t);
  const { readProxyConfig } = await import("../src/config.mjs");

  assert.deepEqual(await readProxyConfig(configDir), {
    host: "ai-proxy.zz.gg",
    origin: "https://ai-proxy.zz.gg",
  });
});

test("config.yml은 hostname 외 값과 unknown key를 거부한다", async (t) => {
  const configDir = await tempDir(t);
  const configFile = path.join(configDir, "config.yml");
  const { readProxyConfig } = await import("../src/config.mjs");
  const invalidSources = [
    "host: https://proxy.example.test/path\n",
    "host: proxy.example.test:443\n",
    "host: bad_host.example.test\n",
    "host: proxy.example.test\nextra: true\n",
    "host: [\n",
  ];

  for (const source of invalidSources) {
    await writeFile(configFile, source);
    await assert.rejects(() => readProxyConfig(configDir), /Invalid zgap config/);
  }
});
