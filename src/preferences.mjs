import { readFile } from "node:fs/promises";
import path from "node:path";
import { defaultConfigDir, writePrivateJson } from "./credentials.mjs";

function preferencesPath(configDir) {
  return path.join(configDir, "preferences.json");
}

function validatePreferences(value) {
  const allowedKeys = new Set(["dangerousMode", "ompLeanMode", "ompLeanSkills"]);
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).some((key) => !allowedKeys.has(key))
    || !Object.hasOwn(value, "dangerousMode")
    || typeof value.dangerousMode !== "boolean"
    || (Object.hasOwn(value, "ompLeanMode") && typeof value.ompLeanMode !== "boolean")
    || (Object.hasOwn(value, "ompLeanSkills") && (
      !Array.isArray(value.ompLeanSkills)
      || value.ompLeanSkills.some((skill) => typeof skill !== "string" || skill.length === 0)
      || new Set(value.ompLeanSkills).size !== value.ompLeanSkills.length
    ))
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

export async function readOmpLeanSkills(configDir = defaultConfigDir()) {
  return (await readPreferences(configDir)).ompLeanSkills ?? [];
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

export async function writeOmpLeanSkills(skills, configDir = defaultConfigDir()) {
  if (!Array.isArray(skills)) throw new TypeError("OMP lean skills preference must be an array.");
  const uniqueSkills = [...new Set(skills)];
  if (uniqueSkills.some((skill) => typeof skill !== "string" || skill.length === 0)) {
    throw new TypeError("OMP lean skills preference must contain non-empty strings.");
  }
  await writePrivateJson(preferencesPath(configDir), {
    ...await readPreferences(configDir),
    ompLeanSkills: uniqueSkills,
  });
}
