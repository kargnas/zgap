import { Buffer } from "node:buffer";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readProxyConfig } from "./config.mjs";
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

export function registerProxyProviders(pi, {
  origin,
  credentialFile,
  requiredFlagName,
  platform = process.platform,
  env = process.env,
  terminate,
}) {
  const apiKey = authTokenCommand(credentialFile, platform);
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
      }],
      ["anthropic", {
        baseUrl: origin,
        api: "anthropic-messages",
        apiKey,
        authHeader: true,
        headers: { "X-Api-Key": apiKey },
      }],
    ],
  });
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
