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
import { checkForGlobalUpdate, updateGlobalInstall } from "./install.mjs";
import { runStartMenu } from "./tui/menu.mjs";
import { runSessionBrowser } from "./tui/session-browser.mjs";

const BACK_TO_START_MENU = Symbol("back-to-start-menu");

export function resumeSession(session, configDir, { codexRunner = runCodex, claudeRunner = runClaude } = {}) {
  if (session?.agent === "codex") return codexRunner(["resume", session.id], { configDir, cwd: session.cwd });
  if (session?.agent === "claude") return claudeRunner(["--resume", session.id], { configDir, cwd: session.cwd });
  throw new Error(`Unsupported session agent: ${session?.agent ?? "unknown"}`);
}

function printHelp() {
  console.log(`Usage:
  zgap login             Sign in with ai-proxy.zz.gg
  zgap logout            Sign out on this device
  zgap codex [args...]   Run Codex through ai-proxy.zz.gg
  zgap claude [args...]  Run Claude through ai-proxy.zz.gg
  zgap sessions          Browse Codex and Claude history
  zgap update            Update zgap from GitHub main

zgap keeps the normal ~/.codex and ~/.claude directories, including their existing history.`);
}

export async function main({
  argv = process.argv.slice(2),
  configDir = defaultConfigDir(),
  credentialStateReader = readCredentialState,
  credentialReader = readCredentialFile,
  startMenu = runStartMenu,
  sessionBrowser = runSessionBrowser,
  updateChecker = checkForGlobalUpdate,
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
  if (command === "codex") return runCodex(args);
  if (command === "claude") return runClaude(args, { configDir });
  if (command === "sessions") {
    return sessionBrowser({ cwd, onSelect: (session) => resumeSession(session, configDir) });
  }
  if (command === "update") {
    return updateGlobalInstall();
  }
  if (!command) {
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
        updateChecker,
        actions: {
          login,
          codex: () => runCodex([]),
          claude: () => runClaude([], { configDir }),
          sessions: async () => {
            let selected = false;
            const browserResult = await sessionBrowser({
              cwd,
              onSelect: (session) => {
                selected = true;
                return resumeSession(session, configDir);
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
