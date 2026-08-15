import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { DEFAULT_HOST, ORIGIN } from "./constants.mjs";

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function invalidConfig() {
  return new Error("Invalid zgap config: expected only `host` with a hostname.");
}

export async function readProxyConfig(configDir) {
  let source;
  try {
    source = await readFile(path.join(configDir, "config.yml"), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { host: DEFAULT_HOST, origin: ORIGIN };
    throw new Error(`Cannot read zgap config: ${error.message}`);
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
