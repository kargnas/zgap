import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "./harness.mjs";

async function tempDir(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zgap-preferences-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("dangerous mode preference defaults to false when preferences.json is absent", async (t) => {
  const configDir = await tempDir(t);
  const { readDangerousMode } = await import("../src/preferences.mjs");

  assert.equal(await readDangerousMode(configDir), false);
});

test("dangerous mode preference writes and reads the exact boolean record", async (t) => {
  const configDir = await tempDir(t);
  const preferencesFile = path.join(configDir, "preferences.json");
  const { readDangerousMode, writeDangerousMode } = await import("../src/preferences.mjs");

  await writeDangerousMode(true, configDir);

  assert.equal(await readDangerousMode(configDir), true);
  assert.equal(await readFile(preferencesFile, "utf8"), '{"dangerousMode":true}\n');
});

test("dangerous mode preference rejects malformed or non-exact records", async (t) => {
  const configDir = await tempDir(t);
  const preferencesFile = path.join(configDir, "preferences.json");
  const { readDangerousMode } = await import("../src/preferences.mjs");

  for (const source of [
    "not json",
    "{}",
    '{"dangerousMode":"yes"}',
    '{"dangerousMode":false,"extra":true}',
    "null",
    "[]",
  ]) {
    await writeFile(preferencesFile, source);
    await assert.rejects(
      () => readDangerousMode(configDir),
      /Invalid zgap dangerous mode preferences/,
    );
  }
});
