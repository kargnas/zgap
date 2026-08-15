import {
  credentialsPath,
  defaultConfigDir,
  logout,
  readCredentialFile,
  readCredentialState,
  decodeAccessTokenProfile,
} from "./credentials.mjs";
import { login } from "./login.mjs";
import { runCodex } from "./codex.mjs";
import { runClaude } from "./claude.mjs";
import { readProxyConfig } from "./config.mjs";
import { checkForGlobalUpdate, updateGlobalInstall } from "./install.mjs";
import { runStartMenu } from "./tui/menu.mjs";
import { runSessionBrowser } from "./tui/session-browser.mjs";

const BACK_TO_START_MENU = Symbol("back-to-start-menu");

export function resumeSession(session, configDir, {
  origin,
  codexRunner = runCodex,
  claudeRunner = runClaude,
} = {}) {
  if (session?.agent === "codex") {
    const options = { configDir, cwd: session.cwd };
    if (origin) options.origin = origin;
    return codexRunner(["resume", session.id], options);
  }
  if (session?.agent === "claude") {
    const options = { configDir, cwd: session.cwd };
    if (origin) options.origin = origin;
    return claudeRunner(["--resume", session.id], options);
  }
  throw new Error(`Unsupported session agent: ${session?.agent ?? "unknown"}`);
}

function printHelp() {
  console.log(`Usage:
  zgap login             Sign in to the credential service
  zgap logout            Sign out on this device
  zgap codex [args...]   Run Codex through the configured proxy
  zgap claude [args...]  Run Claude through the configured proxy
  zgap sessions          Browse agent history
  zgap update            Update zgap from GitHub main

zgap keeps each supported agent's normal local configuration and history.`);
}

export async function main({
  argv = process.argv.slice(2),
  configDir = defaultConfigDir(),
  credentialStateReader = readCredentialState,
  credentialReader = readCredentialFile,
  startMenu = runStartMenu,
  sessionBrowser = runSessionBrowser,
  updateChecker = checkForGlobalUpdate,
  configReader = readProxyConfig,
  cwd = process.cwd(),
} = {}) {
  const [command, ...args] = argv;
  if (command === "login") {
    await login();
    return 0;
  }
  if (command === "logout") {
    await logout({ configDir });
    console.log("Logged out.");
    return 0;
  }
  if (command === "codex") {
    const { origin } = await configReader(configDir);
    return runCodex(args, { configDir, origin });
  }
  if (command === "claude") {
    const { origin } = await configReader(configDir);
    return runClaude(args, { configDir, origin });
  }
  if (command === "sessions") {
    return sessionBrowser({
      cwd,
      onSelect: async (session) => {
        const { origin } = await configReader(configDir);
        return resumeSession(session, configDir, { origin });
      },
    });
  }
  if (command === "update") {
    return updateGlobalInstall();
  }
  if (!command) {
    const proxyConfig = await configReader(configDir);
    while (true) {
      const credentialFile = credentialsPath(configDir);
      const credentialState = await credentialStateReader({
        credentialFile,
      });
      let accountProfile;
      if (credentialState === "signed-in") {
        try {
          const credential = await credentialReader(credentialFile);
          accountProfile = decodeAccessTokenProfile(credential.access_token);
        } catch {
          accountProfile = null;
        }
      }
      const menuResult = await startMenu({
        credentialState,
        accountProfile,
        host: proxyConfig.host,
        origin: proxyConfig.origin,
        updateChecker,
        actions: {
          login,
          codex: () => runCodex([], { configDir, origin: proxyConfig.origin }),
          claude: () => runClaude([], { configDir, origin: proxyConfig.origin }),
          sessions: async () => {
            let selected = false;
            const browserResult = await sessionBrowser({
              cwd,
              onSelect: (session) => {
                selected = true;
                return resumeSession(session, configDir, { origin: proxyConfig.origin });
              },
            });
            return selected || browserResult !== 0 ? browserResult : BACK_TO_START_MENU;
          },
        },
      });
      if (menuResult !== BACK_TO_START_MENU) return menuResult;
    }
  }
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }
  throw new Error(`Unknown command: ${command}`);
}
