import { Buffer } from "node:buffer";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readProxyConfig } from "./config.mjs";
import { fetchModelCatalog } from "./catalog.mjs";
import { credentialsPath, defaultConfigDir } from "./credentials.mjs";
import { installOmpProviderCompat, requiredFlagFromArgv } from "./omp-provider-compat.mjs";

const CLI_FILE = realpathSync(fileURLToPath(new URL("../bin/zgap.mjs", import.meta.url)));

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// OMP re-runs command-backed keys on auth retries, so credential rotation cannot leave a stale token in memory.
export function authTokenCommand(credentialFile, platform = process.platform) {
  const args = [process.execPath, CLI_FILE, "auth-token", credentialFile];
  if (platform === "win32") {
    // EncodedCommand prevents cmd.exe from expanding metacharacters in credential paths.
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    const script = `& ${args.map(quote).join(" ")}\nexit $LASTEXITCODE`;
    return `!powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
  }
  return `!${args.map(shellQuote).join(" ")}`;
}

const OMP_INPUT_MODALITIES = new Set(["text", "image"]);
const OMP_REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

function normalizeProviderModels(models) {
  if (!Array.isArray(models)) throw new Error("OMP model catalog must be an array.");

  const catalogs = {
    "openai-codex": [],
    anthropic: [],
  };
  const ids = {
    "openai-codex": new Set(),
    anthropic: new Set(),
  };

  for (const model of models) {
    if (model?.supported_in_api === false || model?.visibility === "hide") continue;
    if (!model || typeof model !== "object" || Array.isArray(model)) {
      throw new Error("OMP model catalog contains an invalid model.");
    }
    if (typeof model.slug !== "string" || model.slug.trim() === "") {
      throw new Error("OMP model catalog contains a model with an invalid slug.");
    }
    if (typeof model.display_name !== "string" || model.display_name.trim() === "") {
      throw new Error(`OMP model catalog contains an invalid display_name for ${model.slug}.`);
    }
    if (!Number.isSafeInteger(model.context_window) || model.context_window <= 0) {
      throw new Error(`OMP model catalog contains an invalid context_window for ${model.slug}.`);
    }
    if (!Array.isArray(model.input_modalities)) {
      throw new Error(`OMP model catalog contains invalid input_modalities for ${model.slug}.`);
    }
    if (!Array.isArray(model.supported_reasoning_levels)) {
      throw new Error(`OMP model catalog contains invalid supported_reasoning_levels for ${model.slug}.`);
    }

    let provider = "openai-codex";
    let id = model.slug;
    if (model.slug.startsWith("anthropic/")) {
      provider = "anthropic";
      id = model.slug.slice("anthropic/".length);
    } else if (model.slug.startsWith("openai/")) {
      id = model.slug.slice("openai/".length);
    }
    if (id.length === 0) {
      throw new Error(`OMP model catalog contains a model with an invalid slug: ${model.slug}`);
    }
    if (ids[provider].has(id)) {
      throw new Error(`OMP model catalog contains duplicate provider model: ${provider}/${id}.`);
    }
    ids[provider].add(id);

    const input = [];
    for (const modality of model.input_modalities) {
      if (OMP_INPUT_MODALITIES.has(modality) && !input.includes(modality)) input.push(modality);
    }
    if (input.length === 0) input.push("text");

    const efforts = [];
    for (const level of model.supported_reasoning_levels) {
      if (
        level
        && typeof level === "object"
        && !Array.isArray(level)
        && typeof level.description === "string"
        && OMP_REASONING_EFFORTS.has(level.effort)
        && !efforts.includes(level.effort)
      ) efforts.push(level.effort);
    }

    // OMP 18.0.3's runtime finalizer supplies omitted cost/maxTokens from bundled references or runtime defaults.
    const definition = {
      id,
      name: model.display_name,
      reasoning: efforts.length > 0,
      input,
      contextWindow: model.context_window,
    };
    if (efforts.length > 0) {
      definition.thinking = {
        mode: provider === "anthropic" ? "anthropic-adaptive" : "effort",
        efforts,
      };
      if (efforts.includes(model.default_reasoning_level)) {
        definition.thinking.defaultLevel = model.default_reasoning_level;
      }
    }
    catalogs[provider].push(definition);
  }

  for (const [provider, modelsForProvider] of Object.entries(catalogs)) {
    if (modelsForProvider.length === 0) throw new Error(`OMP model catalog for ${provider} is empty.`);
  }
  return catalogs;
}

export function registerProxyProviders(pi, {
  origin,
  credentialFile,
  requiredFlagName,
  models,
  platform = process.platform,
  env = process.env,
  terminate,
}) {
  const apiKey = authTokenCommand(credentialFile, platform);
  const catalogs = normalizeProviderModels(models);
  installOmpProviderCompat(pi, {
    requiredFlagName,
    env,
    terminate,
    providers: [
      ["openai-codex", {
        baseUrl: `${origin}/v1/responses?omp_endpoint=/codex/responses`,
        api: "openai-codex-responses",
        apiKey,
        authHeader: true,
        models: catalogs["openai-codex"],
      }],
      ["anthropic", {
        baseUrl: origin,
        api: "anthropic-messages",
        apiKey,
        authHeader: true,
        headers: { "X-Api-Key": apiKey },
        models: catalogs.anthropic,
      }],
    ],
  });
}

export default async function zgapProxy(pi) {
  const requiredFlagName = requiredFlagFromArgv(process.argv);
  const configDir = defaultConfigDir();
  const { origin } = await readProxyConfig(configDir);
  const { models } = await fetchModelCatalog(configDir, "omp", origin);
  registerProxyProviders(pi, {
    origin,
    credentialFile: credentialsPath(configDir),
    requiredFlagName,
    models,
  });
}
