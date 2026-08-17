import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ORIGIN } from "./constants.mjs";
import { credentialsPath, defaultConfigDir } from "./credentials.mjs";
import { createEphemeralCatalog, removeEphemeralCatalog, resolveCodexExecutable } from "./catalog.mjs";

const CLI_FILE = realpathSync(fileURLToPath(new URL("../bin/zgap.mjs", import.meta.url)));
const FORWARDED_SIGNALS = process.platform === "win32"
  ? ["SIGINT", "SIGTERM"]
  : ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

function providerTable(credentialFile, origin, spaced = false) {
  const quote = JSON.stringify;
  const apiBaseUrl = `${origin}/v1`;
  if (spaced) {
    return `{ name = ${quote("zgap")}, base_url = ${quote(apiBaseUrl)}, auth = { command = ${quote(process.execPath)}, args = [${quote(CLI_FILE)}, ${quote("auth-token")}, ${quote(credentialFile)}] } }`;
  }
  return `{name=${quote("zgap")},base_url=${quote(apiBaseUrl)},auth={command=${quote(process.execPath)},args=[${quote(CLI_FILE)},${quote("auth-token")},${quote(credentialFile)}]}}`;
}

function providerConfig(credentialFile, origin) {
  return `model_providers.zgap=${providerTable(credentialFile, origin)}`;
}

export async function runCodex(args, {
  configDir = defaultConfigDir(),
  cwd = process.cwd(),
  origin = ORIGIN,
} = {}) {
  let receivedSignal;
  let child;
  let ephemeral;
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
  const abortIfSignaled = () => {
    if (receivedSignal) throw new Error(`runCodex interrupted by ${receivedSignal}`);
  };
  const env = { ...process.env };
  delete env.CODEX_HOME;
  delete env.OPENAI_BASE_URL;
  delete env.OPENAI_API_KEY;
  delete env.ZGAP_API_KEY;

  try {
    const codexPath = await resolveCodexExecutable({ env, cwd });
    abortIfSignaled();
    ephemeral = await createEphemeralCatalog({ configDir, codexPath, env, origin });
    abortIfSignaled();
    return await new Promise((resolve, reject) => {
      const launchArgs = [
        "-c",
        providerConfig(credentialsPath(configDir), origin),
        "-c",
        'model_provider="zgap"',
        "-c",
        `model_catalog_json=${JSON.stringify(ephemeral.target)}`,
        ...args,
      ];
      child = spawn(codexPath, launchArgs, { cwd, env, stdio: "inherit" });
      child.once("error", (error) => reject(error.code === "ENOENT"
        ? new Error("Codex CLI is not installed or not in PATH.")
        : error));
      child.once("exit", (code, signal) => {
        resolve(code ?? (signal ? 1 : 0));
      });
    });
  } finally {
    try {
      if (ephemeral) await removeEphemeralCatalog(ephemeral.directory);
    } finally {
      removeSignalHandlers();
      if (receivedSignal) process.kill(process.pid, receivedSignal);
    }
  }
}
