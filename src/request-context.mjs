import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeSystemInfo } from "./system-info.mjs";

export const REQUEST_CONTEXT_HEADER = "X-Zgap-Request-Context";
const TOOLS = new Set(["codex", "claude", "omp"]);
const CONTEXT_FIELDS = [
  "v", "tool", "wrapper_version", "hostname", "os_name", "os_version", "os_arch",
  "cwd", "project", "session_id", "launch_id", "pid",
];
const WRAPPER_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export function resumeSessionId(args) {
  if (!Array.isArray(args)) return undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "resume" && typeof args[index + 1] === "string" && !args[index + 1].startsWith("-")) return args[index + 1];
    if ((arg === "--resume" || arg === "-r" || arg === "--session") && typeof args[index + 1] === "string" && !args[index + 1].startsWith("-")) return args[index + 1];
    for (const flag of ["--resume=", "--session="]) {
      if (arg.startsWith(flag) && arg.length > flag.length) return arg.slice(flag.length);
    }
  }
  return undefined;
}

export function createRequestContext({
  tool,
  cwd = process.cwd(),
  sessionId,
  wrapperVersion = WRAPPER_VERSION,
  systemInfo,
  launchId = randomUUID(),
  pid = process.pid,
} = {}) {
  if (!TOOLS.has(tool)) throw new TypeError("Invalid request context tool.");
  const info = systemInfo ?? normalizeSystemInfo({
    platform: os.platform(),
    hostname: os.hostname(),
    release: os.release(),
    arch: os.arch(),
  });
  const absoluteCwd = path.resolve(cwd);
  const context = {
    v: 1,
    tool,
    wrapper_version: String(wrapperVersion),
    ...normalizeSystemInfo({
      platform: info.os_name,
      hostname: info.hostname,
      release: info.os_version,
      arch: info.os_arch,
    }),
    cwd: absoluteCwd,
    project: path.basename(absoluteCwd),
    launch_id: String(launchId),
    pid,
  };
  if (typeof sessionId === "string" && sessionId.length > 0) context.session_id = sessionId;
  return context;
}

export function requestContextHeaders(context) {
  // Base64URL keeps the JSON transport-safe while avoiding prompts and argv content entirely.
  const payload = Object.fromEntries(CONTEXT_FIELDS
    .filter((field) => context?.[field] !== undefined)
    .map((field) => [field, context[field]]));
  return { [REQUEST_CONTEXT_HEADER]: Buffer.from(JSON.stringify(payload), "utf8").toString("base64url") };
}

export function decodeRequestContext(value) {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return decoded && typeof decoded === "object" && decoded.v === 1 ? decoded : null;
  } catch {
    return null;
  }
}
