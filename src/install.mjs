import { lstat, readFile, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfigDir, writePrivateJson } from "./credentials.mjs";

// Bun reuses the global lockfile's pinned commit when re-adding a branch spec, even with
// --force and --no-cache, so updates must go through `bun update`, which re-resolves #main.
const UPDATE_ARGS = ["update", "-g", "zgap", "--force", "--no-cache"];
const GITHUB_MAIN_API = "https://api.github.com/repos/kargnas/zgap/commits/main";
// GitHub allows 60 unauthenticated API requests per hour per IP, shared with every other
// tool on the machine, so the last known main head is cached and refetched at most hourly.
const REMOTE_HEAD_TTL_MS = 60 * 60_000;
const SHA_RE = /^[0-9a-f]{40}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  return run("bun", UPDATE_ARGS);
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

export function remoteHeadCachePath(configDir) {
  return path.join(configDir, "update-check.json");
}

async function readRemoteHeadCache(cacheFile) {
  try {
    const cached = JSON.parse(await readFile(cacheFile, "utf8"));
    if (SHA_RE.test(cached?.sha) && DATE_RE.test(cached?.commitDate) && Number.isFinite(cached?.checkedAt)) return cached;
  } catch {
    // A missing or unreadable cache only means the head has to be fetched again.
  }
  return null;
}

// Resolves the GitHub main head as { sha, commitDate, etag?, checkedAt }, or null when GitHub
// could not answer. A cache younger than the TTL is returned without touching the network.
async function fetchRemoteHead({ fetcher, signal, timeoutMs, cacheFile }) {
  const cached = await readRemoteHeadCache(cacheFile);
  const now = Date.now();
  if (cached && now - cached.checkedAt < REMOTE_HEAD_TTL_MS) return cached;
  const headers = { accept: "application/vnd.github+json" };
  // A conditional request answered with 304 does not count against the rate limit.
  if (typeof cached?.etag === "string") headers["if-none-match"] = cached.etag;
  const response = await fetcher(GITHUB_MAIN_API, {
    headers,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
  });
  let head;
  if (response.status === 304 && cached) {
    head = { ...cached };
  } else {
    if (!response.ok) return null;
    const remote = await response.json();
    const commitDate = (remote.commit?.author?.date ?? remote.commit?.committer?.date)?.slice(0, 10);
    if (!SHA_RE.test(remote.sha) || !DATE_RE.test(commitDate)) return null;
    head = { sha: remote.sha.toLowerCase(), commitDate };
    const etag = response.headers.get("etag");
    if (etag) head.etag = etag;
  }
  head.checkedAt = now;
  await writePrivateJson(cacheFile, head);
  return head;
}

export async function checkForGlobalUpdate({
  packageRoot = packageRootFromModule(),
  globalRoot,
  configDir = defaultConfigDir(),
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

    const remote = await fetchRemoteHead({ fetcher, signal, timeoutMs, cacheFile: remoteHeadCachePath(configDir) });
    if (!remote) return { state: "error" };
    if (remote.sha.startsWith(installed)) return { state: "current", commitDate: remote.commitDate };

    const exitCode = await run("bun", UPDATE_ARGS);
    if (exitCode !== 0) return { state: "error" };
    // Bun exits 0 even when it keeps the previous commit, so only the lockfile pin
    // moving to the remote sha proves the reinstall actually happened.
    const updatedLockfile = await readFile(path.join(resolvedGlobalRoot, "bun.lock"), "utf8").catch(() => null);
    const reinstalled = updatedLockfile === null ? null : installedCommit(updatedLockfile);
    if (!reinstalled || !remote.sha.startsWith(reinstalled)) return { state: "error" };
    return { state: "updated", commitDate: remote.commitDate };
  } catch {
    return { state: "error" };
  }
}
