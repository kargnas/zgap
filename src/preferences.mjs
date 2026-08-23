import { readFile } from "node:fs/promises";
import path from "node:path";
import { defaultConfigDir, writePrivateJson } from "./credentials.mjs";

function preferencesPath(configDir) {
  return path.join(configDir, "preferences.json");
}

function validatePreferences(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).length !== 1
    || !Object.hasOwn(value, "dangerousMode")
    || typeof value.dangerousMode !== "boolean"
  ) throw new Error("Invalid zgap dangerous mode preferences.");
  return value.dangerousMode;
}

export async function readDangerousMode(configDir = defaultConfigDir()) {
  let source;
  try {
    source = await readFile(preferencesPath(configDir), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new Error(`Cannot read zgap dangerous mode preferences: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid zgap dangerous mode preferences: ${error.message}`);
  }
  return validatePreferences(parsed);
}

export async function writeDangerousMode(enabled, configDir = defaultConfigDir()) {
  if (typeof enabled !== "boolean") throw new TypeError("Dangerous mode preference must be a boolean.");
  await writePrivateJson(preferencesPath(configDir), { dangerousMode: enabled });
}
