import { access, chmod, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { credentialsPath, readCredentialFile, resolveAccessToken } from "./credentials.mjs";
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

export async function readBundledModels(codexPath, env = process.env) {
  const output = await runCapture(codexPath, ["debug", "models", "--bundled"], env);
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Bundled model catalog returned an invalid response.");
  }
  if (!Array.isArray(parsed?.models) || parsed.models.length === 0) {
    throw new Error("Bundled model catalog returned an invalid response.");
  }
  return parsed.models;
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

function combineModels(serverModels, bundledModels) {
  const fallbackModels = serverModels
    .filter((model) => model?.provider !== "openai")
    .map((model) => {
      if (!model || typeof model !== "object") return model;
      const { provider: _provider, ...withoutProvider } = model;
      return withoutProvider;
    });
  const models = [...bundledModels, ...fallbackModels];
  validateModels(models, "Model catalog");
  return { models };
}

export async function fetchModelCatalog(configDir, clientVersion) {
  const credentialFile = credentialsPath(configDir);
  const credential = await readCredentialFile(credentialFile);
  const accessToken = await resolveAccessToken({ credentialFile });
  const url = new URL("/v1/models", credential.origin);
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
  if (catalog.zgap_client_policy?.openai_models?.mode !== "replace_with_local_bundle") {
    throw new Error("Model catalog returned an invalid zgap_client_policy.");
  }
  return catalog;
}

export async function createEphemeralCatalog({ configDir, codexPath, env = process.env }) {
  const clientVersion = await readCodexVersion(codexPath, env);
  const serverCatalog = await fetchModelCatalog(configDir, clientVersion);
  const bundledModels = await readBundledModels(codexPath, env);
  validateModels(bundledModels, "Bundled model catalog");
  const catalog = combineModels(serverCatalog.models, bundledModels);
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
