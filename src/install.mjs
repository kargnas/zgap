import { lstat, readFile, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UPDATE_SPEC = "github:kargnas/zgap#main";
const GITHUB_MAIN_API = "https://api.github.com/repos/kargnas/zgap/commits/main";

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

function runSilentCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

export async function updateGlobalInstall({
  run = runCommand,
} = {}) {
  return run("bun", ["add", "-g", UPDATE_SPEC, "--force", "--no-cache"]);
}

function isWithin(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function installedCommit(lockfile) {
  return lockfile.match(/github:kargnas\/zgap#([0-9a-f]{7,40})/i)?.[1]?.toLowerCase();
}

async function resolvedPath(value) {
  try {
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
}

function packageRootFromModule() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function globalRootFromPackage(packageRoot) {
  const nodeModules = path.dirname(packageRoot);
  if (path.basename(packageRoot) !== "zgap" || path.basename(nodeModules) !== "node_modules") return null;
  return path.dirname(nodeModules);
}

export async function checkForGlobalUpdate({
  packageRoot = packageRootFromModule(),
  globalRoot,
  fetcher = fetch,
  run = runSilentCommand,
  signal,
  timeoutMs = 5_000,
} = {}) {
  try {
    const resolvedPackageRoot = await resolvedPath(packageRoot);
    const candidateGlobalRoot = globalRoot ?? globalRootFromPackage(resolvedPackageRoot);
    if (!candidateGlobalRoot) return { state: "skipped" };
    const resolvedGlobalRoot = await resolvedPath(candidateGlobalRoot);
    const installedPackageRoot = path.join(resolvedGlobalRoot, "node_modules", "zgap");
    const installedPackage = await lstat(installedPackageRoot).catch(() => null);
    const resolvedInstalledPackageRoot = await resolvedPath(installedPackageRoot);
    if (!installedPackage?.isDirectory()
      || installedPackage.isSymbolicLink()
      || resolvedInstalledPackageRoot !== resolvedPackageRoot
      || !isWithin(resolvedGlobalRoot, resolvedInstalledPackageRoot)) {
      return { state: "skipped" };
    }

    const lockfile = await readFile(path.join(resolvedGlobalRoot, "bun.lock"), "utf8").catch(() => null);
    if (lockfile === null) return { state: "skipped" };
    const installed = installedCommit(lockfile);
    if (!installed) return { state: "error" };

    const response = await fetcher(GITHUB_MAIN_API, {
      headers: { accept: "application/vnd.github+json" },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { state: "error" };
    const remote = await response.json();
    const commitDate = (remote.commit?.author?.date ?? remote.commit?.committer?.date)?.slice(0, 10);
    if (!/^[0-9a-f]{40}$/i.test(remote.sha) || !/^\d{4}-\d{2}-\d{2}$/.test(commitDate)) {
      return { state: "error" };
    }
    if (remote.sha.toLowerCase().startsWith(installed)) return { state: "current", commitDate };

    const exitCode = await run("bun", ["add", "-g", UPDATE_SPEC, "--force", "--no-cache"]);
    return exitCode === 0 ? { state: "updated", commitDate } : { state: "error" };
  } catch {
    return { state: "error" };
  }
}
