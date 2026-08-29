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

test("launch mode preferences default to false when preferences.json is absent", async (t) => {
  const configDir = await tempDir(t);
  const { readDangerousMode, readOmpLeanSkills } = await import("../src/preferences.mjs");

  assert.equal(await readDangerousMode(configDir), false);
  assert.deepEqual(await readOmpLeanSkills(configDir), []);
});

test("launch mode writers preserve the other preferences", async (t) => {
  const configDir = await tempDir(t);
  const preferencesFile = path.join(configDir, "preferences.json");
  const {
    readDangerousMode,
    readOmpLeanSkills,
    writeDangerousMode,
    writeOmpLeanSkills,
  } = await import("../src/preferences.mjs");

  await writeDangerousMode(true, configDir);
  assert.equal(await readDangerousMode(configDir), true);
  assert.equal(await readFile(preferencesFile, "utf8"), '{"dangerousMode":true}\n');

  await writeOmpLeanSkills(["alpha"], configDir);
  assert.equal(await readDangerousMode(configDir), true);
  assert.deepEqual(await readOmpLeanSkills(configDir), ["alpha"]);
  assert.equal(await readFile(preferencesFile, "utf8"), '{"dangerousMode":true,"ompLeanSkills":["alpha"]}\n');

  await writeDangerousMode(false, configDir);
  assert.deepEqual(await readOmpLeanSkills(configDir), ["alpha"]);
  assert.equal(await readFile(preferencesFile, "utf8"), '{"dangerousMode":false,"ompLeanSkills":["alpha"]}\n');
});

test("OMP lean skills preserve exact unique names and existing preferences", async (t) => {
  const configDir = await tempDir(t);
  const preferencesFile = path.join(configDir, "preferences.json");
  const { readOmpLeanSkills, writeOmpLeanSkills } = await import("../src/preferences.mjs");

  await writeFile(preferencesFile, '{"dangerousMode":false}\n');
  assert.deepEqual(await readOmpLeanSkills(configDir), []);

  await writeOmpLeanSkills(["alpha", "beta", "alpha"], configDir);
  assert.deepEqual(await readOmpLeanSkills(configDir), ["alpha", "beta"]);
  assert.equal(await readFile(preferencesFile, "utf8"), '{"dangerousMode":false,"ompLeanSkills":["alpha","beta"]}\n');

  await writeOmpLeanSkills([], configDir);
  assert.deepEqual(await readOmpLeanSkills(configDir), []);
  assert.equal(await readFile(preferencesFile, "utf8"), '{"dangerousMode":false,"ompLeanSkills":[]}\n');
});

test("launch mode preferences reject malformed or unknown records", async (t) => {
  const configDir = await tempDir(t);
  const preferencesFile = path.join(configDir, "preferences.json");
  const { readDangerousMode } = await import("../src/preferences.mjs");

  for (const source of [
    "not json",
    "{}",
    '{"dangerousMode":"yes"}',
    '{"dangerousMode":false,"ompLeanSkills":["ok",""]}',
    '{"dangerousMode":false,"ompLeanSkills":["ok","ok"]}',
    '{"dangerousMode":false,"ompLeanSkills":[1]}',
    '{"dangerousMode":false,"extra":true}',
    "null",
    "[]",
  ]) {
    await writeFile(preferencesFile, source);
    await assert.rejects(
      () => readDangerousMode(configDir),
      /Invalid zgap launch mode preferences/,
    );
  }
});
