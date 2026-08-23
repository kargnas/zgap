import { spawn, execFile } from "node:child_process";
import { access, chmod, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ORIGIN } from "./constants.mjs";
import { credentialsPath, defaultConfigDir } from "./credentials.mjs";
import { fetchModelCatalog } from "./catalog.mjs";

const CLI_FILE = realpathSync(fileURLToPath(new URL("../bin/zgap.mjs", import.meta.url)));
const FORWARDED_SIGNALS = process.platform === "win32"
  ? ["SIGINT", "SIGTERM"]
  : ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
// OMP's ThinkingLevel enum; the proxy also advertises "ultra", which OMP does not accept.
const OMP_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

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
  if (!match) throw new Error("OMP --version returned an invalid response.");
  return match[1];
}

export function catalogToOmpModels(catalog) {
  const models = [];
  let defaultSlug;
  let defaultPriority = Infinity;
  for (const model of catalog.models) {
    // The server marks list-hidden models with visibility "hide"; registering them in OMP
    // would surface them in its picker, so the server's hiding intent is respected here.
    if (model.visibility === "hide") continue;
    if (!Number.isFinite(model.context_window) || model.context_window <= 0) {
      throw new Error(`Model catalog entry ${model.slug} is missing a valid context_window.`);
    }
    const efforts = (Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [])
      .map((level) => level?.effort)
      .filter((effort) => OMP_EFFORTS.has(effort));
    models.push({
      id: model.slug,
      name: model.display_name || model.slug,
      reasoning: efforts.length > 0,
      ...(efforts.length > 0 ? { thinking: { mode: "effort", efforts } } : {}),
      input: Array.isArray(model.input_modalities) && model.input_modalities.includes("image") ? ["text", "image"] : ["text"],
      // The proxy bills upstream, so client-side cost metadata stays zero.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.context_window,
      // The catalog carries no output cap; the proxy enforces per-model limits server-side.
      maxTokens: 128000,
    });
    // The server ranks its catalog through `priority` (lower wins), so the default model
    // selection stays server-owned instead of a hard-coded model ID.
    const priority = Number.isFinite(model.priority) ? model.priority : Infinity;
    if (defaultSlug === undefined || priority < defaultPriority) {
      defaultSlug = model.slug;
      defaultPriority = priority;
    }
  }
  if (models.length === 0) throw new Error("Model catalog returned no listable models.");
  return { models, defaultSlug };
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// OMP treats a "!command" apiKey as a shell command and re-runs it on auth retries, so
// the zgap helper keeps serving fresh tokens across credential rotation.
function authTokenCommand(credentialFile) {
  return `!${[process.execPath, CLI_FILE, "auth-token", credentialFile].map(shellQuote).join(" ")}`;
}

function extensionSource(origin, credentialFile, models) {
  // A dedicated "zgap" provider with an explicit model list is registered instead of
  // overriding OMP's bundled anthropic/openai-codex providers: an override without
  // `models` leaves the bundled models' endpoints unchanged in OMP 18, and a separate
  // provider also keeps the user's own OMP providers untouched.
  // The codex transport appends /codex/responses unless the URL already ends with it, so
  // the omp_endpoint query keeps the wire path at /v1/responses while satisfying that check.
  return `// zgap ephemeral OMP extension: registers the zgap proxy provider for this run only.
export default function zgapProxy(pi) {
  pi.registerProvider("zgap", {
    baseUrl: ${JSON.stringify(`${origin}/v1/responses?omp_endpoint=/codex/responses`)},
    apiKey: ${JSON.stringify(authTokenCommand(credentialFile))},
    api: "openai-codex-responses",
    authHeader: true,
    models: ${JSON.stringify(models, null, 2)},
  });
}
`;
}

export async function createEphemeralExtension({ configDir, ompPath, env = process.env, origin }) {
  const clientVersion = await readOmpVersion(ompPath, env);
  const catalog = await fetchModelCatalog(configDir, clientVersion, origin);
  const { models, defaultSlug } = catalogToOmpModels(catalog);
  const directory = await mkdtemp(path.join(os.tmpdir(), "zgap-"));
  try {
    await chmod(directory, 0o700);
    const target = path.join(directory, "extension.mjs");
    await writeFile(target, extensionSource(origin, credentialsPath(configDir), models), { mode: 0o600 });
    await chmod(target, 0o600);
    // Without this overlay a bare `zgap omp` would start on the user's own default model
    // role and bypass the proxy; an explicit --model or a user --config still wins.
    const overlay = path.join(directory, "overlay.yml");
    await writeFile(overlay, `modelRoles:\n  default: ${JSON.stringify(`zgap/${defaultSlug}`)}\n`, { mode: 0o600 });
    await chmod(overlay, 0o600);
    return { directory, target, overlay };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function removeEphemeralExtension(directory) {
  await rm(directory, { recursive: true, force: true });
}

export async function runOmp(args, {
  configDir = defaultConfigDir(),
  cwd = process.cwd(),
  origin = ORIGIN,
  dangerousMode = false,
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
    if (receivedSignal) throw new Error(`runOmp interrupted by ${receivedSignal}`);
  };
  const env = { ...process.env };
  // Inherited gateway variables would steer OMP's bundled providers at stale endpoints,
  // so they are scrubbed the same way the Codex and Claude runners scrub theirs.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_BASE_URL;
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  delete env.ZGAP_API_KEY;
  // The proxy supports the Codex websocket transport; an explicit user value still wins
  // because the variable is also OMP's documented fallback-debug switch.
  env.PI_CODEX_WEBSOCKET ??= "1";

  try {
    const ompPath = await resolveOmpExecutable({ env, cwd });
    abortIfSignaled();
    ephemeral = await createEphemeralExtension({ configDir, ompPath, env, origin });
    abortIfSignaled();
    return await new Promise((resolve, reject) => {
      // The temporary extension stays on disk for the whole run because OMP subagents
      // re-import extension paths after startup; it is removed once the child exits.
      child = spawn(ompPath, [
        "-e", ephemeral.target,
        "--config", ephemeral.overlay,
        // YOLO mode skips OMP's tool-approval prompts, matching the Codex/Claude runners.
        ...(dangerousMode && !args.includes("--auto-approve") && !args.some((arg) => arg.startsWith("--approval-mode="))
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
    try {
      if (ephemeral) await removeEphemeralExtension(ephemeral.directory);
    } finally {
      removeSignalHandlers();
      if (receivedSignal) process.kill(process.pid, receivedSignal);
    }
  }
}
