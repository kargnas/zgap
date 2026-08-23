import { execFile, spawn } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants as fsConstants, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { credentialsPath, defaultConfigDir, resolveAccessToken } from "./credentials.mjs";

const OMP_EXTENSION_FILE = realpathSync(fileURLToPath(new URL("./omp-provider-extension.mjs", import.meta.url)));
const MINIMUM_OMP_VERSION = [18, 0, 3];
const OMP_VALUE_FLAGS = new Set([
  "--cwd", "--config", "--add-dir", "--mode", "--fork", "--provider", "--model", "--smol", "--slow",
  "--plan", "--prewalk-into", "--plan-yolo-into", "--max-time", "--service-tier", "--api-key",
  "--system-prompt", "--append-system-prompt", "--provider-session-id", "--prompt-cache-key",
  "--session-dir", "--models", "--tools", "--thinking", "--export", "--hook", "--extension", "-e",
  "--trusted-extension", "--plugin-dir", "--skills", "--approval-mode", "--profile", "--alias",
]);
const OMP_OPTIONAL_VALUE_FLAGS = new Set(["--resume", "-r", "--session"]);
const FORWARDED_SIGNALS = process.platform === "win32"
  ? ["SIGINT", "SIGTERM"]
  : ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

async function executable(pathname) {
  try {
    await access(pathname, fsConstants.X_OK);
    return (await stat(pathname)).isFile();
  } catch {
    return false;
  }
}

export async function resolveOmpExecutable({ env = process.env, cwd = process.cwd() } = {}) {
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const entry of (env.PATH ?? "").split(path.delimiter)) {
    for (const suffix of suffixes) {
      const candidate = path.resolve(cwd, entry || ".", `omp${suffix}`);
      if (await executable(candidate)) return realpath(candidate);
    }
  }
  throw new Error("OMP CLI is not installed or not in PATH.");
}

export async function readOmpVersion(ompPath, env = process.env) {
  const output = await new Promise((resolve, reject) => {
    execFile(ompPath, ["--version"], { env, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`OMP command failed (--version): ${stderr.trim() || error.message}`));
      else resolve(stdout);
    });
  });
  const match = output.match(/^\s*omp\/([^\s]+)\s*$/im);
  if (!match) throw new Error("OMP 18.0.3 or newer is required; --version returned an invalid response.");
  return match[1];
}

function assertSupportedOmpVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  if (match) {
    let comparison = 0;
    let valid = true;
    for (let index = 0; index < MINIMUM_OMP_VERSION.length; index += 1) {
      const component = Number(match[index + 1]);
      if (!Number.isSafeInteger(component)) {
        valid = false;
        break;
      }
      if (comparison === 0) comparison = Math.sign(component - MINIMUM_OMP_VERSION[index]);
    }
    if (valid && (comparison > 0 || (comparison === 0 && !match[4]))) return;
  }
  throw new Error(`OMP 18.0.3 or newer is required; found ${version}.`);
}

function invokesDisabledUsage(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") return false;
    if (!arg.startsWith("-")) return arg === "usage";
    if (arg.startsWith("--") && arg.includes("=")) continue;
    if (OMP_VALUE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    const next = args[index + 1];
    if (OMP_OPTIONAL_VALUE_FLAGS.has(arg) && next?.length > 0 && !next.startsWith("-")) index += 1;
  }
  return false;
}

export async function runOmp(args, {
  configDir = defaultConfigDir(),
  cwd = process.cwd(),
  dangerousMode = false,
} = {}) {
  if (invokesDisabledUsage(args)) throw new Error("OMP usage is disabled while using zgap.");
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
  const abortIfSignaled = () => {
    if (receivedSignal) throw new Error(`runOmp interrupted by ${receivedSignal}`);
  };

  try {
    const env = process.env;
    const ompPath = await resolveOmpExecutable({ env, cwd });
    abortIfSignaled();
    await resolveAccessToken({ credentialFile: credentialsPath(configDir) });
    abortIfSignaled();
    assertSupportedOmpVersion(await readOmpVersion(ompPath, env));
    abortIfSignaled();
    return await new Promise((resolve, reject) => {
      child = spawn(ompPath, [
        "--trusted-extension", OMP_EXTENSION_FILE,
        ...(dangerousMode && !args.includes("--auto-approve") && !args.includes("--approval-mode") && !args.some((arg) => arg.startsWith("--approval-mode="))
          ? ["--auto-approve"]
          : []),
        ...args,
      ], { cwd, env, stdio: "inherit" });
      child.once("error", (error) => reject(error.code === "ENOENT"
        ? new Error("OMP CLI is not installed or not in PATH.")
        : error));
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    removeSignalHandlers();
    if (receivedSignal) process.kill(process.pid, receivedSignal);
  }
}
