import { Buffer } from "node:buffer";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readProxyConfig } from "./config.mjs";
import { credentialsPath, defaultConfigDir } from "./credentials.mjs";

const CLI_FILE = realpathSync(fileURLToPath(new URL("../bin/zgap.mjs", import.meta.url)));
const FOUNDRY_ENVIRONMENT = [
  "CLAUDE_CODE_USE_FOUNDRY",
  "FOUNDRY_BASE_URL",
  "CLAUDE_CODE_CLIENT_CERT",
  "CLAUDE_CODE_CLIENT_KEY",
];

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

export function registerProxyProviders(pi, {
  origin,
  credentialFile,
  platform = process.platform,
  env = process.env,
}) {
  // Foundry routing and custom auth headers outrank model overrides and could send credentials to the wrong host.
  for (const name of FOUNDRY_ENVIRONMENT) delete env[name];
  sanitizeAnthropicCustomHeaders(env);
  const apiKey = authTokenCommand(credentialFile, platform);
  pi.registerProvider("openai-codex", {
    baseUrl: `${origin}/v1/responses?omp_endpoint=/codex/responses`,
    apiKey,
    authHeader: true,
    usage: usageProvider("openai-codex"),
  });
  pi.registerProvider("anthropic", {
    baseUrl: origin,
    apiKey,
    authHeader: true,
    headers: { "X-Api-Key": apiKey },
    usage: usageProvider("anthropic"),
  });
}

export default async function zgapProxy(pi) {
  const configDir = defaultConfigDir();
  const { origin } = await readProxyConfig(configDir);
  registerProxyProviders(pi, { origin, credentialFile: credentialsPath(configDir) });
}
