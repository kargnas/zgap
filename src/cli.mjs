import {
  credentialsPath,
  defaultConfigDir,
  logout,
  readCredentialState,
} from "./credentials.mjs";
import { login } from "./login.mjs";
import { runCodex } from "./codex.mjs";
import { runClaude } from "./claude.mjs";
import { detectInstallation, printNpmMigrationWarning, updateGlobalInstall } from "./install.mjs";
import { runStartMenu } from "./tui/menu.mjs";

function printHelp() {
  console.log(`Usage:
  zgap login             Sign in with ai-proxy.zz.gg
  zgap logout            Sign out on this device
  zgap codex [args...]   Run Codex through ai-proxy.zz.gg
  zgap claude [args...]  Run Claude through ai-proxy.zz.gg
  zgap update            Update the global zgap installation with Bun

zgap keeps the normal ~/.codex and ~/.claude directories, including their existing history.`);
}

export async function main({
  argv = process.argv.slice(2),
  bunGlobalBin,
  configDir = defaultConfigDir(),
  credentialStateReader = readCredentialState,
  entryPath = process.argv[1],
  invokedPath = entryPath,
  modulePath = entryPath,
  startMenu = runStartMenu,
} = {}) {
  const [command, ...args] = argv;
  const installation = detectInstallation({ entryPath, invokedPath, modulePath, bunGlobalBin });
  if (installation === "npm") printNpmMigrationWarning();
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
  if (command === "update") {
    return updateGlobalInstall({ installation, emitWarning: false });
  }
  if (!command) {
    const credentialState = await credentialStateReader({
      credentialFile: credentialsPath(configDir),
    });
    return startMenu({
      credentialState,
      actions: {
        login,
        codex: () => runCodex([]),
        claude: () => runClaude([], { configDir }),
      },
    });
  }
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }
  throw new Error(`Unknown command: ${command}`);
}
