import { spawn } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ORIGIN } from "./constants.mjs";
import { credentialsPath, defaultConfigDir } from "./credentials.mjs";
import { createRequestContext, requestContextHeaders, resumeSessionId } from "./request-context.mjs";

const CLI_FILE = realpathSync(fileURLToPath(new URL("../bin/zgap.mjs", import.meta.url)));
const FORWARDED_SIGNALS = process.platform === "win32"
  ? ["SIGINT", "SIGTERM"]
  : ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
const CLEARED_ENV = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_AWS_API_KEY", "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_BEDROCK_MANTLE_BASE_URL", "ANTHROPIC_BEDROCK_REGION_PREFIX",
  "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_AUTH_TOKEN", "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE", "ANTHROPIC_GOOGLE_CLOUD_BASE_URL", "ANTHROPIC_GOOGLE_CLOUD_LOCATION",
  "ANTHROPIC_GOOGLE_CLOUD_PROJECT", "ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID", "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE", "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION", "ANTHROPIC_UNIX_SOCKET",
  "ANTHROPIC_VERTEX_BASE_URL", "ANTHROPIC_VERTEX_PROJECT_ID", "ANTHROPIC_WORKSPACE_ID", "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_API_BASE_URL", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
  "CLAUDE_CODE_CUSTOM_OAUTH_URL", "CLAUDE_CODE_GB_BASE_URL", "CLAUDE_CODE_HFI_BEARER_TOKEN",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_PROXY_AUTHENTICATE",
  "CLAUDE_CODE_PROXY_URL", "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_GATEWAY", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "CLAUDE_CODE_USE_CCR_V2", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
];
function claudeSettingsEnv(origin, requestHeaders) {
  return {
    ...Object.fromEntries(CLEARED_ENV.map((name) => [name, ""])),
    ANTHROPIC_BASE_URL: origin,
    ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5[1m]",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5[1m]",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "262144",
    CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: "1",
    ANTHROPIC_CUSTOM_HEADERS: Object.entries(requestHeaders).map(([key, value]) => `${key}: ${value}`).join("\n"),
  };
}

async function executable(pathname) {
  try {
    await access(pathname, fsConstants.X_OK);
    return (await stat(pathname)).isFile();
  } catch {
    return false;
  }
}

export async function resolveClaudeExecutable({ env = process.env, cwd = process.cwd() } = {}) {
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const entry of (env.PATH ?? "").split(path.delimiter)) {
    for (const suffix of suffixes) {
      const candidate = path.resolve(cwd, entry || ".", `claude${suffix}`);
      if (await executable(candidate)) return realpath(candidate);
    }
  }
  throw new Error("Claude CLI is not installed or not in PATH.");
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function apiKeyHelper(credentialFile) {
  return [process.execPath, CLI_FILE, "auth-token", credentialFile].map(shellQuote).join(" ");
}

export async function runClaude(args, {
  configDir = defaultConfigDir(),
  cwd = process.cwd(),
  origin = ORIGIN,
  dangerousMode = false,
} = {}) {
  if (args.some((arg) => arg === "--settings" || arg.startsWith("--settings="))) {
    throw new Error("zgap claude supplies --settings automatically; remove the user-provided --settings option.");
  }
  let receivedSignal;
  let child;
  let handlersRemoved = false;
  const signalHandlers = new Map();
  const removeSignalHandlers = () => {
    if (handlersRemoved) return;
    handlersRemoved = true;
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  };
  for (const signal of FORWARDED_SIGNALS) {
    const handler = () => {
      if (receivedSignal) return;
      receivedSignal = signal;
      if (child?.exitCode == null) child?.kill(signal);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  const env = { ...process.env };
  for (const name of CLEARED_ENV) delete env[name];
  const requestHeaders = requestContextHeaders(createRequestContext({
    tool: "claude",
    cwd,
    sessionId: resumeSessionId(args),
  }));
  env.ANTHROPIC_BASE_URL = origin;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = "claude-opus-5[1m]";
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = "claude-sonnet-5[1m]";
  env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
  env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = "262144";
  env.ANTHROPIC_CUSTOM_HEADERS = Object.entries(requestHeaders).map(([key, value]) => `${key}: ${value}`).join("\n");
  const abortIfSignaled = () => {
    if (receivedSignal) throw new Error(`runClaude interrupted by ${receivedSignal}`);
  };
  try {
    const claudePath = await resolveClaudeExecutable({ env, cwd });
    abortIfSignaled();
    return await new Promise((resolve, reject) => {
      child = spawn(claudePath, [
        "--settings",
        JSON.stringify({ apiKeyHelper: apiKeyHelper(credentialsPath(configDir)), env: claudeSettingsEnv(origin, requestHeaders) }),
        ...(dangerousMode && !args.includes("--dangerously-skip-permissions")
          ? ["--dangerously-skip-permissions"]
          : []),
        ...args,
      ], { cwd, env, stdio: "inherit" });
      child.once("error", (error) => reject(error.code === "ENOENT"
        ? new Error("Claude CLI is not installed or not in PATH.")
        : error));
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    removeSignalHandlers();
    if (receivedSignal) process.kill(process.pid, receivedSignal);
  }
}
