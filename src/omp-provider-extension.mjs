import { Buffer } from "node:buffer";
import { closeSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readProxyConfig } from "./config.mjs";
import { fetchModelCatalog } from "./catalog.mjs";
import { credentialsPath, defaultConfigDir, readApiKeyDescriptor, resolveAccessToken } from "./credentials.mjs";
import { CREDENTIAL_FD_FLAG, credentialFdFromArgv, installOmpProviderCompat, requiredFlagFromArgv } from "./omp-provider-compat.mjs";
import { createRequestContext, requestContextHeaders, resumeSessionId } from "./request-context.mjs";

const CLI_FILE = realpathSync(fileURLToPath(new URL("../bin/zgap.mjs", import.meta.url)));

// One dedicated provider name keeps zgap models from masquerading as the official
// `openai-codex`/`anthropic` providers, so OMP account-bound flows (usage reports,
// auto-redeem, ChatGPT-account claims, official web search) never see proxy credentials.
export const PROVIDER_NAME = "zzgg";

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// OMP ships as a Bun single-file executable, so inside the extension `process.execPath`
// is the OMP binary itself and running it would relaunch OMP instead of the zgap CLI.
// runOmp passes its own runtime path in ZGAP_RUNTIME so the key command always names a
// real script runtime.
export function runtimeExecutable(env = process.env) {
  const runtime = env.ZGAP_RUNTIME;
  if (typeof runtime !== "string" || runtime.length === 0) {
    throw new Error("zgap runtime path is missing; run OMP through `zgap omp`.");
  }
  return runtime;
}

// OMP re-runs command-backed keys on auth retries, so credential rotation cannot leave a stale token in memory.
export function authTokenCommand(credentialFile, platform = process.platform, env = process.env) {
  const args = [runtimeExecutable(env), CLI_FILE, "auth-token", credentialFile];
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
const CODEX_API = "openai-codex-responses";
const ANTHROPIC_API = "anthropic-messages";

function normalizeProviderModels(models) {
  if (!Array.isArray(models)) throw new Error("OMP model catalog must be an array.");

  const definitions = [];
  const ids = new Set();

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

    // Anthropic-family slugs speak the Messages protocol; every other slug is served
    // through the proxy's Codex Responses endpoint (including third-party namespaces
    // such as `openrouter/...` or `moonshot/...`, which the proxy translates upstream).
    // Codex websockets and the OpenAI priority/fast service tier key off `api` and the
    // `gpt-*`/`codex-*` model-id patterns, so both survive the dedicated provider name.
    let api = CODEX_API;
    let id = model.slug;
    if (model.slug.startsWith("anthropic/")) {
      api = ANTHROPIC_API;
      id = model.slug.slice("anthropic/".length);
    } else if (model.slug.startsWith("openai/")) {
      id = model.slug.slice("openai/".length);
    }
    if (id.length === 0) {
      throw new Error(`OMP model catalog contains a model with an invalid slug: ${model.slug}`);
    }
    if (ids.has(id)) {
      throw new Error(`OMP model catalog contains duplicate model id: ${id}.`);
    }
    ids.add(id);

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
      api,
      reasoning: efforts.length > 0,
      input,
      contextWindow: model.context_window,
    };
    if (efforts.length > 0) {
      definition.thinking = {
        mode: api === ANTHROPIC_API ? "anthropic-adaptive" : "effort",
        efforts,
      };
      if (efforts.includes(model.default_reasoning_level)) {
        definition.thinking.defaultLevel = model.default_reasoning_level;
      }
    }
    definitions.push(definition);
  }

  if (definitions.length === 0) throw new Error("OMP model catalog is empty.");
  return definitions;
}

// `apiKey` is either the command key from authTokenCommand (credential file) or a literal key read
// once from a credential descriptor; `commandBackedApiKey` tells the compat guard which to expect.
export function registerProxyProviders(pi, {
  origin,
  apiKey,
  commandBackedApiKey,
  requiredFlagName,
  models,
  env = process.env,
  terminate,
  requestContext = createRequestContext({ tool: "omp", cwd: process.cwd(), sessionId: resumeSessionId(process.argv.slice(2)) }),
}) {
  const contextHeaders = requestContextHeaders(requestContext);
  const codexBaseUrl = `${origin}/v1/responses?omp_endpoint=/codex/responses`;
  const providerModels = normalizeProviderModels(models).map((definition) => definition.api === ANTHROPIC_API
    // Parity with the previous dedicated Anthropic registration: the proxy accepts
    // either header, and direct Anthropic clients send both bearer and X-Api-Key.
    ? { ...definition, baseUrl: origin, headers: { ...contextHeaders, "X-Api-Key": apiKey } }
    : { ...definition, baseUrl: codexBaseUrl, headers: contextHeaders });
  installOmpProviderCompat(pi, {
    requiredFlagName,
    commandBackedApiKey,
    env,
    terminate,
    providers: [
      [PROVIDER_NAME, {
        baseUrl: origin,
        apiKey,
        authHeader: true,
        headers: contextHeaders,
        models: providerModels,
      }],
    ],
  });
}

const SEARXNG_ENVIRONMENT = [
  "SEARXNG_ENDPOINT",
  "SEARXNG_TOKEN",
  "SEARXNG_BASIC_USERNAME",
  "SEARXNG_BASIC_PASSWORD",
];
// Access tokens stay valid for hours; a 10-minute cadence refreshes long before expiry.
const SEARXNG_TOKEN_REFRESH_MS = 10 * 60 * 1000;

// OMP's SearXNG web-search provider re-reads SEARXNG_* from the environment on every
// request, so a process-local injection routes `web_search` through the proxy's
// authenticated `/searxng` passthrough without touching user configuration. This
// replaces the OpenAI-account-bound Codex web search lost by the provider rename.
export async function installProxySearch({
  origin,
  credentialFile,
  env = process.env,
  scheduleRefresh = setInterval,
  resolveToken = resolveAccessToken,
} = {}) {
  // Any user-supplied SearXNG configuration wins over injection. Basic-auth values are
  // included because OMP prefers Basic over bearer and a partial mix would break auth.
  if (SEARXNG_ENVIRONMENT.some((name) => typeof env[name] === "string" && env[name].length > 0)) return null;
  // Token before endpoint: a resolve failure must not leave the endpoint set without auth.
  env.SEARXNG_TOKEN = await resolveToken({ credentialFile });
  env.SEARXNG_ENDPOINT = `${origin}/searxng`;
  const timer = scheduleRefresh(async () => {
    try {
      env.SEARXNG_TOKEN = await resolveToken({ credentialFile });
    } catch {
      // Keep the previous token; once it expires the proxy rejects the next search
      // with a visible 401 instead of failing silently here on a transient error.
    }
  }, SEARXNG_TOKEN_REFRESH_MS);
  timer?.unref?.();
  return timer;
}

export default async function zgapProxy(pi) {
  const requiredFlagName = requiredFlagFromArgv(process.argv);
  const credentialFd = credentialFdFromArgv(process.argv);
  const configDir = defaultConfigDir();
  const { origin } = await readProxyConfig(configDir);
  if (credentialFd !== undefined) {
    // OMP's second argv parse rejects unknown flags, so the descriptor flag is registered like the handshake.
    pi.registerFlag(CREDENTIAL_FD_FLAG, { type: "number", description: "Descriptor holding the one-use zgap credential." });
    let apiKey;
    try {
      apiKey = readApiKeyDescriptor(credentialFd);
    } finally {
      // Nothing below zgap may hold the credential pipe once the key is in memory.
      closeSync(credentialFd);
    }
    const { models } = await fetchModelCatalog(apiKey, "omp", origin);
    // No SearXNG injection here: SEARXNG_TOKEN would sit in OMP's environment, which its tool
    // children inherit, and a one-use credential exists precisely to keep the key out of them.
    registerProxyProviders(pi, { origin, apiKey, commandBackedApiKey: false, requiredFlagName, models });
    return;
  }
  const credentialFile = credentialsPath(configDir);
  const { models } = await fetchModelCatalog(await resolveAccessToken({ credentialFile }), "omp", origin);
  registerProxyProviders(pi, {
    origin,
    apiKey: authTokenCommand(credentialFile),
    commandBackedApiKey: true,
    requiredFlagName,
    models,
  });
  await installProxySearch({ origin, credentialFile });
}
