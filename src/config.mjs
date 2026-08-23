import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { DEFAULT_HOST } from "./constants.mjs";

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DEFAULT_CONFIG = `# Agent proxy hostname used for login and all supported agent requests.\n# Use a hostname only, without https://, a port, or a path.\nhost: ${DEFAULT_HOST}\n`;

function invalidConfig() {
  return new Error("Invalid zgap config: expected only `host` with a hostname.");
}

export async function readProxyConfig(configDir) {
  const configPath = path.join(configDir, "config.yml");
  let source;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`Cannot read zgap config: ${error.message}`);
    }
    try {
      await mkdir(configDir, { recursive: true });
      // Exclusive creation preserves a config written by another zgap process or the user.
      await writeFile(configPath, DEFAULT_CONFIG, { encoding: "utf8", flag: "wx" });
      source = DEFAULT_CONFIG;
    } catch (initializationError) {
      if (initializationError?.code !== "EEXIST") {
        throw new Error(`Cannot initialize zgap config: ${initializationError.message}`);
      }
      try {
        source = await readFile(configPath, "utf8");
      } catch (readError) {
        throw new Error(`Cannot read zgap config after initialization: ${readError.message}`);
      }
    }
  }
  let parsed;
  try {
    parsed = parse(source);
  } catch {
    throw invalidConfig();
  }
  if (
    !parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, "host")
    || typeof parsed.host !== "string"
  ) throw invalidConfig();
  const host = parsed.host.toLowerCase();
  if (!HOST_RE.test(host)) throw invalidConfig();
  return { host, origin: `https://${host}` };
}
