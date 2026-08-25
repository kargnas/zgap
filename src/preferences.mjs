import { readFile } from "node:fs/promises";
import path from "node:path";
import { defaultConfigDir, writePrivateJson } from "./credentials.mjs";

function preferencesPath(configDir) {
  return path.join(configDir, "preferences.json");
}

function validatePreferences(value) {
  const allowedKeys = new Set(["dangerousMode", "ompLeanMode"]);
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).some((key) => !allowedKeys.has(key))
    || !Object.hasOwn(value, "dangerousMode")
    || typeof value.dangerousMode !== "boolean"
    || (Object.hasOwn(value, "ompLeanMode") && typeof value.ompLeanMode !== "boolean")
  ) throw new Error("Invalid zgap launch mode preferences.");
  return value;
}

async function readPreferences(configDir) {
  let source;
  try {
    source = await readFile(preferencesPath(configDir), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { dangerousMode: false };
    throw new Error(`Cannot read zgap launch mode preferences: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid zgap launch mode preferences: ${error.message}`);
  }
  return validatePreferences(parsed);
}

export async function readDangerousMode(configDir = defaultConfigDir()) {
  return (await readPreferences(configDir)).dangerousMode;
}

export async function readOmpLeanMode(configDir = defaultConfigDir()) {
  return (await readPreferences(configDir)).ompLeanMode ?? false;
}

export async function writeDangerousMode(enabled, configDir = defaultConfigDir()) {
  if (typeof enabled !== "boolean") throw new TypeError("Dangerous mode preference must be a boolean.");
  await writePrivateJson(preferencesPath(configDir), {
    ...await readPreferences(configDir),
    dangerousMode: enabled,
  });
}

export async function writeOmpLeanMode(enabled, configDir = defaultConfigDir()) {
  if (typeof enabled !== "boolean") throw new TypeError("OMP lean mode preference must be a boolean.");
  await writePrivateJson(preferencesPath(configDir), {
    ...await readPreferences(configDir),
    ompLeanMode: enabled,
  });
}
