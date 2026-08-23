import { Buffer } from "node:buffer";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readProxyConfig } from "./config.mjs";
import { credentialsPath, defaultConfigDir } from "./credentials.mjs";

const CLI_FILE = realpathSync(fileURLToPath(new URL("../bin/zgap.mjs", import.meta.url)));
const PROVIDER_OVERRIDE_FAILURE = "zgap OMP provider override verification failed.";
const FOUNDRY_ENVIRONMENT = [
  "CLAUDE_CODE_USE_FOUNDRY",
  "FOUNDRY_BASE_URL",
  "CLAUDE_CODE_CLIENT_CERT",
  "CLAUDE_CODE_CLIENT_KEY",
];
const USAGE_BLOCKER_SYMBOL = Symbol.for("zgap.omp.fetchUsageReports.blocker");
const USAGE_REPORTS_BLOCKER = sharedUsageBlocker();

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

function sharedUsageBlocker() {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, USAGE_BLOCKER_SYMBOL);
  if (descriptor) {
    if (
      typeof descriptor.value !== "function"
      || descriptor.writable !== false
      || descriptor.configurable !== false
    ) throw new Error(PROVIDER_OVERRIDE_FAILURE);
    return descriptor.value;
  }
  const blocker = async () => [];
  Object.defineProperty(globalThis, USAGE_BLOCKER_SYMBOL, {
    value: blocker,
    writable: false,
    configurable: false,
  });
  return blocker;
}

function installUsageBlocker(authStorage) {
  const descriptor = Object.getOwnPropertyDescriptor(authStorage, "fetchUsageReports");
  if (descriptor) {
    if (
      descriptor.value === USAGE_REPORTS_BLOCKER
      && descriptor.writable === false
      && descriptor.configurable === false
    ) return true;
    if (descriptor.configurable === false) return false;
  }
  Object.defineProperty(authStorage, "fetchUsageReports", {
    value: USAGE_REPORTS_BLOCKER,
    writable: false,
    configurable: false,
    enumerable: false,
  });
  return true;
}

function usageProvider(id) {
  return {
    id,
    supports: () => false,
    fetchUsage: async () => null,
  };
}

function sanitizeAnthropicCustomHeaders(env) {
  const source = env.ANTHROPIC_CUSTOM_HEADERS;
  if (typeof source !== "string") return;
  const preserved = [];
  for (const token of source.split(/\r?\n|,/)) {
    const entry = token.trim();
    const separator = entry.indexOf(":");
    if (separator <= 0) continue;
    const key = entry.slice(0, separator).trim().toLowerCase();
    const value = entry.slice(separator + 1).trim();
    if (!key || !value || key === "authorization" || key === "x-api-key") continue;
    preserved.push(`${key}: ${value}`);
  }
  if (preserved.length > 0) env.ANTHROPIC_CUSTOM_HEADERS = preserved.join("\n");
  else delete env.ANTHROPIC_CUSTOM_HEADERS;
}

function sanitizeProxyEnvironment(env) {
  // Foundry routing and custom auth headers outrank model overrides and could send credentials to the wrong host.
  for (const name of FOUNDRY_ENVIRONMENT) delete env[name];
  sanitizeAnthropicCustomHeaders(env);
}

function defaultTerminate(message) {
  try {
    process.stderr.write(`${message}\n`);
  } finally {
    process.exit(1);
  }
}

function requiredFlagFromArgv(argv) {
  const candidates = argv.filter((arg) => arg.startsWith("--zgap-provider-override-required"));
  if (candidates.length !== 1) throw new Error("Invalid zgap OMP provider override handshake.");
  const match = candidates[0].match(/^--(zgap-provider-override-required-[0-9a-f]{32})=true$/);
  if (!match) throw new Error("Invalid zgap OMP provider override handshake.");
  return match[1];
}

function registerProviders(registerProvider, { origin, apiKey, requiredFlagName }) {
  registerProvider("openai-codex", {
    baseUrl: `${origin}/v1/responses?omp_endpoint=/codex/responses`,
    api: "openai-codex-responses",
    apiKey,
    authHeader: true,
    headers: { "X-Zgap-Provider-Override": requiredFlagName },
    usage: usageProvider("openai-codex"),
  });
  registerProvider("anthropic", {
    baseUrl: origin,
    api: "anthropic-messages",
    apiKey,
    authHeader: true,
    headers: {
      "X-Zgap-Provider-Override": requiredFlagName,
      "X-Api-Key": apiKey,
    },
    usage: usageProvider("anthropic"),
  });
}

function headerValue(headers, name) {
  const expected = name.toLowerCase();
  let found;
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() !== expected || typeof value !== "string") continue;
    if (found !== undefined && found !== value) return undefined;
    found = value;
  }
  return found;
}

async function validProviderRequest(ctx, expectedProviders, requiredFlagName) {
  const { model, modelRegistry } = ctx;
  const provider = model.provider;
  const expected = expectedProviders[provider];
  if (
    model.api !== expected.api
    || model.transport !== undefined
    || model.baseUrl !== expected.baseUrl
    || modelRegistry.getProviderBaseUrl(provider) !== expected.baseUrl
    || !modelRegistry.hasCommandBackedApiKey(provider)
    || headerValue(modelRegistry.getProviderHeaders(provider), "x-zgap-provider-override") !== requiredFlagName
  ) return false;

  const resolvedKey = await modelRegistry.getApiKey(model);
  if (typeof resolvedKey !== "string" || resolvedKey.trim().length === 0) return false;
  if (headerValue(model.headers, "authorization") !== `Bearer ${resolvedKey}`) return false;
  if (provider === "anthropic" && headerValue(model.headers, "x-api-key") !== resolvedKey) return false;
  return true;
}

function validTargetCatalog(modelRegistry, expectedProviders, requiredFlagName) {
  const seen = new Set();
  for (const model of modelRegistry.getAll()) {
    const expected = expectedProviders[model.provider];
    if (!expected) continue;
    seen.add(model.provider);
    if (
      model.api !== expected.api
      || model.transport !== undefined
      || model.baseUrl !== expected.baseUrl
    ) return false;
  }
  for (const provider of seen) {
    const expected = expectedProviders[provider];
    if (
      modelRegistry.getProviderBaseUrl(provider) !== expected.baseUrl
      || !modelRegistry.hasCommandBackedApiKey(provider)
      || headerValue(modelRegistry.getProviderHeaders(provider), "x-zgap-provider-override") !== requiredFlagName
    ) return false;
  }
  return true;
}

export function registerProxyProviders(pi, {
  origin,
  credentialFile,
  requiredFlagName,
  platform = process.platform,
  env = process.env,
  terminate = defaultTerminate,
}) {
  pi.registerFlag(requiredFlagName, {
    type: "boolean",
    description: "Require this zgap provider override extension instance to load.",
  });
  sanitizeProxyEnvironment(env);

  const registration = {
    origin,
    apiKey: authTokenCommand(credentialFile, platform),
    requiredFlagName,
  };
  const expectedProviders = {
    "openai-codex": {
      api: "openai-codex-responses",
      baseUrl: `${origin}/v1/responses?omp_endpoint=/codex/responses`,
    },
    anthropic: { api: "anthropic-messages", baseUrl: origin },
  };
  const targetProviders = new Set(Object.keys(expectedProviders));
  const failClosed = () => {
    try {
      terminate(PROVIDER_OVERRIDE_FAILURE);
    } catch {
      // Termination hooks are contained so OMP cannot swallow their failure and continue.
    }
  };

  registerProviders((name, config) => pi.registerProvider(name, config), registration);
  pi.on("session_start", async (_event, ctx) => {
    try {
      sanitizeProxyEnvironment(env);
      if (!installUsageBlocker(ctx.modelRegistry.authStorage)) {
        failClosed();
        return;
      }
      registerProviders((name, config) => ctx.modelRegistry.registerProvider(name, config), registration);
      if (!validTargetCatalog(ctx.modelRegistry, expectedProviders, requiredFlagName)) {
        failClosed();
        return;
      }
      const model = ctx.model;
      if (!targetProviders.has(model?.provider)) return;
      const refreshed = ctx.modelRegistry.find(model.provider, model.id);
      if (!refreshed || !(await pi.setModel(refreshed))) failClosed();
    } catch {
      failClosed();
    }
  });
  const validateProvider = async (_event, ctx) => {
    try {
      sanitizeProxyEnvironment(env);
      const provider = ctx.model?.provider;
      if (!targetProviders.has(provider)) return;
      if (!(await validProviderRequest(ctx, expectedProviders, requiredFlagName))) failClosed();
    } catch {
      failClosed();
    }
  };
  pi.on("before_agent_start", validateProvider);
  pi.on("before_provider_request", validateProvider);
}

export default async function zgapProxy(pi) {
  const requiredFlagName = requiredFlagFromArgv(process.argv);
  const configDir = defaultConfigDir();
  const { origin } = await readProxyConfig(configDir);
  registerProxyProviders(pi, {
    origin,
    credentialFile: credentialsPath(configDir),
    requiredFlagName,
  });
}
