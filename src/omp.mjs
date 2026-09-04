import { execFile, spawn } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants as fsConstants, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { credentialsPath, defaultConfigDir, resolveAccessToken } from "./credentials.mjs";
import {
  assertOmpLaunchArgs,
  assertOmpVersion,
  createOmpProviderHandshakeArgument,
} from "./omp-provider-compat.mjs";

const OMP_EXTENSION_FILE = realpathSync(fileURLToPath(new URL("./omp-provider-extension.mjs", import.meta.url)));
const OMP_LEAN_ARGS = [
  "--no-extensions",
  "--no-skills",
  "--no-rules",
  "--no-title",
  "--tools=read,bash,edit,write",
];
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
  throw new Error("OMP CLI is not installed or not in PATH. Install it with:\n  curl -fsSL https://omp.sh/install | sh");
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

export async function runOmp(launchArgs, {
  configDir = defaultConfigDir(),
  cwd = process.cwd(),
  dangerousMode = false,
  leanMode = false,
  ompLeanSkills = [],
} = {}) {
  const args = launchArgs;
  assertOmpLaunchArgs(args);
  if (!Array.isArray(ompLeanSkills) || ompLeanSkills.some((skill) => typeof skill !== "string" || skill.length === 0)) {
    throw new TypeError("OMP lean skills must be an array of non-empty strings.");
  }
  const hasToolsArg = args.some((arg) => arg === "--tools" || arg.startsWith("--tools="));
  const hasSkillsArg = args.some((arg) => arg === "--skills" || arg === "--no-skills" || arg.startsWith("--skills="));
  const selectedSkills = leanMode ? [...new Set(ompLeanSkills)] : [];
  const leanArgs = leanMode
    ? OMP_LEAN_ARGS.flatMap((arg) => {
      if (arg === "--no-skills") {
        if (hasSkillsArg) return [];
        return selectedSkills.length > 0 ? [`--skills=${selectedSkills.join(",")}`] : [arg];
      }
      if (arg === "--tools=read,bash,edit,write" && hasToolsArg) return [];
      return [arg];
    })
    : [];
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
    // ZGAP_RUNTIME: the provider extension runs inside OMP, whose `process.execPath` is
    // the OMP single-file binary, so it cannot derive a script runtime for the key command.
    // OMP_SKIP_SETUP: the extension already supplies credentials and the model catalog, so
    // OMP's first-run wizard would only re-ask what zgap owns. Skip it for this child only
    // and leave a user-provided value untouched.
    const env = { ...process.env, ZGAP_RUNTIME: process.execPath };
    if (env.OMP_SKIP_SETUP === undefined) env.OMP_SKIP_SETUP = "1";
    const ompPath = await resolveOmpExecutable({ env, cwd });
    abortIfSignaled();
    // OMP rebuilds this extension for every session it creates, so the credential must stay
    // re-readable for the whole run. Fail here instead of inside OMP when it is missing.
    await resolveAccessToken({ credentialFile: credentialsPath(configDir) });
    abortIfSignaled();
    assertOmpVersion(await readOmpVersion(ompPath, env));
    abortIfSignaled();
    const handshakeArgument = createOmpProviderHandshakeArgument();
    return await new Promise((resolve, reject) => {
      child = spawn(ompPath, [
        "-e", OMP_EXTENSION_FILE,
        // This random flag exists only if this exact extension loaded; otherwise OMP's second parse rejects it.
        handshakeArgument,
        ...(dangerousMode && !args.includes("--auto-approve") && !args.includes("--approval-mode") && !args.some((arg) => arg.startsWith("--approval-mode="))
          ? ["--auto-approve"]
          : []),
        ...leanArgs,
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
