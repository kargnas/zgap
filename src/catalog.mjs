import { access, chmod, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { credentialsPath, resolveAccessToken } from "./credentials.mjs";
import { REQUEST_TIMEOUT_MS } from "./constants.mjs";

async function executable(pathname) {
  try {
    await access(pathname, fsConstants.X_OK);
    return (await stat(pathname)).isFile();
  } catch {
    return false;
  }
}

export async function resolveCodexExecutable({ env = process.env, cwd = process.cwd() } = {}) {
  const pathEntries = (env.PATH ?? "").split(path.delimiter);
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const entry of pathEntries) {
    for (const suffix of suffixes) {
      const candidate = path.resolve(cwd, entry || ".", `codex${suffix}`);
      if (await executable(candidate)) return realpath(candidate);
    }
  }
  throw new Error("Codex CLI is not installed or not in PATH.");
}

async function runCapture(codexPath, args, env = process.env) {
  return new Promise((resolve, reject) => {
    execFile(codexPath, args, { env, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Codex command failed (${args.join(" ")}): ${stderr.trim() || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function readCodexVersion(codexPath, env = process.env) {
  const output = await runCapture(codexPath, ["--version"], env);
  const match = output.match(/^\s*codex-cli\s+([^\s]+)\s*$/i);
  if (!match) throw new Error("Codex --version returned an invalid response.");
  return match[1];
}

function validateModels(models, label) {
  const slugs = new Set();
  for (const model of models) {
    if (!model || typeof model !== "object" || typeof model.slug !== "string" || model.slug.trim() === "") {
      throw new Error(`${label} contains a model with an invalid slug.`);
    }
    if (slugs.has(model.slug)) throw new Error(`Model catalog contains duplicate slug: ${model.slug}`);
    slugs.add(model.slug);
  }
}

export async function fetchModelCatalog(configDir, clientVersion, origin) {
  const credentialFile = credentialsPath(configDir);
  const accessToken = await resolveAccessToken({ credentialFile });
  const url = new URL("/v1/models", origin);
  url.searchParams.set("client_version", clientVersion);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const catalog = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Model catalog request failed (${response.status}).`);
  if (!Array.isArray(catalog?.models) || catalog.models.length === 0) {
    throw new Error("Model catalog returned an invalid response.");
  }
  validateModels(catalog.models, "Model catalog");
  return { models: catalog.models };
}

export async function createEphemeralCatalog({ configDir, codexPath, env = process.env, origin }) {
  const clientVersion = await readCodexVersion(codexPath, env);
  const catalog = await fetchModelCatalog(configDir, clientVersion, origin);
  const directory = await mkdtemp(path.join(os.tmpdir(), "zgap-"));
  try {
    await chmod(directory, 0o700);
    const target = path.join(directory, "catalog.json");
    await writeFile(target, `${JSON.stringify(catalog)}\n`, { mode: 0o600 });
    await chmod(target, 0o600);
    return { directory, target, catalog };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function removeEphemeralCatalog(directory) {
  await rm(directory, { recursive: true, force: true });
}
