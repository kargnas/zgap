/**
 * OMP 18.0.3 workaround boundary.
 *
 * Delete this module only after OMP natively supports all three capabilities:
 * required additive extension loading, final provider override ownership, and
 * provider usage disabling.
 */
import { randomBytes } from "node:crypto";

const MINIMUM_OMP_VERSION = [18, 0, 3];
const PROVIDER_OVERRIDE_FAILURE = "zgap OMP provider override verification failed.";
const FOUNDRY_ENVIRONMENT = [
  "CLAUDE_CODE_USE_FOUNDRY",
  "FOUNDRY_BASE_URL",
  "CLAUDE_CODE_CLIENT_CERT",
  "CLAUDE_CODE_CLIENT_KEY",
];
const USAGE_BLOCKER_SYMBOL = Symbol.for("zgap.omp.fetchUsageReports.blocker");
const OMP_VALUE_FLAGS = new Set([
  "--cwd", "--config", "--add-dir", "--mode", "--fork", "--provider", "--model", "--smol", "--slow",
  "--plan", "--prewalk-into", "--plan-yolo-into", "--max-time", "--service-tier", "--api-key",
  "--system-prompt", "--append-system-prompt", "--provider-session-id", "--prompt-cache-key",
  "--session-dir", "--models", "--tools", "--thinking", "--export", "--hook", "--extension", "-e",
  "--trusted-extension", "--plugin-dir", "--skills", "--approval-mode", "--profile", "--alias",
]);
const OMP_OPTIONAL_VALUE_FLAGS = new Set(["--resume", "-r", "--session"]);
const OMP_MANAGEMENT_COMMANDS = new Set([
  "auth-broker", "auth-gateway", "agents", "bench", "browser-relay", "cleanse", "commit",
  "completions", "__complete", "compress", "config", "dry-balance", "gc", "grep", "gallery",
  "grievances", "images", "img", "install", "join", "models", "plugin", "ps", "say", "share",
  "setup", "shell", "read", "render", "ssh", "stats", "update", "usage", "tiny-models", "token",
  "ttsr", "worktree", "wt", "search", "q", "help",
]);

export function assertOmpVersion(version) {
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

function firstResidualPositional(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") return undefined;
    if (!arg.startsWith("-")) return arg;
    if (arg.startsWith("--") && arg.includes("=")) continue;
    if (OMP_VALUE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    const next = args[index + 1];
    if (OMP_OPTIONAL_VALUE_FLAGS.has(arg) && next?.length > 0 && !next.startsWith("-")) index += 1;
  }
  return undefined;
}

export function assertOmpLaunchArgs(args) {
  const command = firstResidualPositional(args);
  if (command === "usage") throw new Error("OMP usage is disabled while using zgap.");
  if (OMP_MANAGEMENT_COMMANDS.has(command)) {
    throw new Error(`OMP command "${command}" is unavailable through zgap; run \`omp ${command}\` directly.`);
  }
}

export function createOmpProviderHandshakeArgument() {
  const name = `zgap-provider-override-required-${randomBytes(16).toString("hex")}`;
  return `--${name}=true`;
}

export const CREDENTIAL_FD_FLAG = "zgap-credential-fd";

// runOmp reopens a one-use credential as a pipe on this descriptor for the extension. The number
// travels in argv, like the handshake flag, so no credential state is ambient in the environment.
export function credentialFdFromArgv(argv) {
  const prefix = `--${CREDENTIAL_FD_FLAG}=`;
  const candidates = argv.filter((arg) => arg.startsWith(prefix));
  if (candidates.length === 0) return undefined;
  if (candidates.length > 1) throw new Error("Invalid zgap OMP credential descriptor argument.");
  const fd = Number(candidates[0].slice(prefix.length));
  if (!Number.isInteger(fd) || fd < 3) throw new Error("Invalid zgap OMP credential descriptor argument.");
  return fd;
}

export function requiredFlagFromArgv(argv) {
  const candidates = argv.filter((arg) => arg.startsWith("--zgap-provider-override-required"));
  if (candidates.length !== 1) throw new Error("Invalid zgap OMP provider override handshake.");
  const match = candidates[0].match(/^--(zgap-provider-override-required-[0-9a-f]{32})=true$/);
  if (!match) throw new Error("Invalid zgap OMP provider override handshake.");
  return match[1];
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

function getSharedUsageBlocker() {
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

function installUsageBlocker(authStorage, usageBlocker) {
  const descriptor = Object.getOwnPropertyDescriptor(authStorage, "fetchUsageReports");
  if (descriptor) {
    if (
      descriptor.value === usageBlocker
      && descriptor.writable === false
      && descriptor.configurable === false
    ) return true;
    if (descriptor.configurable === false) return false;
  }
  Object.defineProperty(authStorage, "fetchUsageReports", {
    value: usageBlocker,
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

function compatRegistrations(providers, requiredFlagName) {
  return providers.map(([id, config]) => [id, {
    ...config,
    headers: {
      ...config.headers,
      "X-Zgap-Provider-Override": requiredFlagName,
    },
    usage: usageProvider(id),
  }]);
}

function registerProviders(registerProvider, registrations) {
  for (const [name, config] of registrations) {
    if (!Array.isArray(config.models) || config.models.length === 0) {
      registerProvider(name, config);
      continue;
    }
    const { models, ...providerConfig } = config;
    registerProvider(name, { ...providerConfig, models });
    // OMP 18.0.3 returns after model overlays, so provider headers and routing need a
    // separate registration. It must not carry a baseUrl: a provider-level baseUrl is
    // applied as a transport override to every model and would clobber the per-model
    // baseUrls (Codex query endpoint vs Anthropic origin) set by the model overlays.
    const { baseUrl: _modelOwnedBaseUrl, ...transportConfig } = providerConfig;
    registerProvider(name, transportConfig);
  }
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

// One provider now mixes wire protocols, so the expected transport is keyed by each
// model's `api` (Codex Responses vs Anthropic Messages), not by the provider name.
function expectedProviderTargets(registrations) {
  const targets = {};
  for (const [id, config] of registrations) {
    const apis = {};
    for (const model of config.models ?? []) {
      const api = model.api ?? config.api;
      const baseUrl = model.baseUrl ?? config.baseUrl;
      if (typeof api !== "string" || typeof baseUrl !== "string") {
        throw new Error(PROVIDER_OVERRIDE_FAILURE);
      }
      if (apis[api] !== undefined && apis[api] !== baseUrl) {
        throw new Error(PROVIDER_OVERRIDE_FAILURE);
      }
      apis[api] = baseUrl;
    }
    if (Object.keys(apis).length === 0) {
      if (typeof config.api !== "string" || typeof config.baseUrl !== "string") {
        throw new Error(PROVIDER_OVERRIDE_FAILURE);
      }
      apis[config.api] = config.baseUrl;
    }
    targets[id] = { apis, baseUrls: new Set(Object.values(apis)) };
  }
  return targets;
}

function validTargetModel(model, expected) {
  const expectedBaseUrl = expected.apis[model.api];
  return expectedBaseUrl !== undefined
    && model.transport === undefined
    && model.baseUrl === expectedBaseUrl;
}

async function validProviderRequest(ctx, expectedProviders, requiredFlagName, commandBackedApiKey) {
  const { model, modelRegistry } = ctx;
  const provider = model.provider;
  const expected = expectedProviders[provider];
  if (
    !validTargetModel(model, expected)
    // getProviderBaseUrl returns the first model-defined baseUrl, so with mixed
    // per-model endpoints any member of the expected set proves override ownership.
    || !expected.baseUrls.has(modelRegistry.getProviderBaseUrl(provider))
    || modelRegistry.hasCommandBackedApiKey(provider) !== commandBackedApiKey
    || headerValue(modelRegistry.getProviderHeaders(provider), "x-zgap-provider-override") !== requiredFlagName
  ) return false;

  const resolvedKey = await modelRegistry.getApiKey(model);
  if (typeof resolvedKey !== "string" || resolvedKey.trim().length === 0) return false;
  if (headerValue(model.headers, "authorization") !== `Bearer ${resolvedKey}`) return false;
  if (model.api === "anthropic-messages" && headerValue(model.headers, "x-api-key") !== resolvedKey) return false;
  return true;
}

function validTargetCatalog(modelRegistry, expectedProviders, requiredFlagName, commandBackedApiKey) {
  const seen = new Set();
  for (const model of modelRegistry.getAll()) {
    const expected = expectedProviders[model.provider];
    if (!expected) continue;
    seen.add(model.provider);
    if (!validTargetModel(model, expected)) return false;
  }
  for (const provider of seen) {
    const expected = expectedProviders[provider];
    if (
      !expected.baseUrls.has(modelRegistry.getProviderBaseUrl(provider))
      || modelRegistry.hasCommandBackedApiKey(provider) !== commandBackedApiKey
      || headerValue(modelRegistry.getProviderHeaders(provider), "x-zgap-provider-override") !== requiredFlagName
    ) return false;
  }
  return true;
}

export function installOmpProviderCompat(pi, {
  providers,
  requiredFlagName,
  // A file-backed credential registers a command key that OMP re-runs on auth retries; a
  // descriptor-backed one registers the literal key. The registry must report exactly the
  // shape that was registered, or another extension replaced the provider's key.
  commandBackedApiKey,
  env = process.env,
  terminate = defaultTerminate,
}) {
  if (typeof commandBackedApiKey !== "boolean") throw new TypeError("commandBackedApiKey must be a boolean.");
  pi.registerFlag(requiredFlagName, {
    type: "boolean",
    description: "Require this zgap provider override extension instance to load.",
  });
  const failClosed = () => {
    try {
      terminate(PROVIDER_OVERRIDE_FAILURE);
    } catch {
      // Termination hooks are contained so OMP cannot swallow their failure and continue.
    }
  };

  let usageBlocker;
  try {
    usageBlocker = getSharedUsageBlocker();
    sanitizeProxyEnvironment(env);
  } catch {
    failClosed();
    return;
  }

  let registrations;
  let expectedProviders;
  try {
    registrations = compatRegistrations(providers, requiredFlagName);
    expectedProviders = expectedProviderTargets(registrations);
  } catch {
    failClosed();
    return;
  }
  const targetProviders = new Set(Object.keys(expectedProviders));

  registerProviders((name, config) => pi.registerProvider(name, config), registrations);
  pi.on("session_start", async (_event, ctx) => {
    try {
      sanitizeProxyEnvironment(env);
      if (!installUsageBlocker(ctx.modelRegistry.authStorage, usageBlocker)) {
        failClosed();
        return;
      }
      registerProviders((name, config) => ctx.modelRegistry.registerProvider(name, config), registrations);
      if (!validTargetCatalog(ctx.modelRegistry, expectedProviders, requiredFlagName, commandBackedApiKey)) {
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
      if (!(await validProviderRequest(ctx, expectedProviders, requiredFlagName, commandBackedApiKey))) failClosed();
    } catch {
      failClosed();
    }
  };
  pi.on("before_agent_start", validateProvider);
  pi.on("before_provider_request", validateProvider);
}
