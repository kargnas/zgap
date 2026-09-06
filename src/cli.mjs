import {
  credentialsPath,
  defaultConfigDir,
  logout,
  readCredentialFile,
  readCredentialState,
  decodeAccessTokenProfile,
  saveApiKey,
} from "./credentials.mjs";
import { readApiKey } from "./api-key.mjs";
import { login } from "./login.mjs";
import { runCodex } from "./codex.mjs";
import { runClaude } from "./claude.mjs";
import { runOmp } from "./omp.mjs";
import { runServe } from "./serve.mjs";
import { discoverOmpSkills } from "./omp-skills.mjs";
import { readProxyConfig } from "./config.mjs";
import {
  readDangerousMode,
  readOmpLeanSkills,
  writeDangerousMode,
  writeOmpLeanSkills,
} from "./preferences.mjs";
import { checkForGlobalUpdate, updateGlobalInstall } from "./install.mjs";
import { runLoginMenu, runStartMenu } from "./tui/menu.mjs";
import { runSessionBrowser } from "./tui/session-browser.mjs";

const BACK_TO_START_MENU = Symbol("back-to-start-menu");

// zgap passes only the session id and stays in the directory it was launched from. Each
// agent decides on its own whether to work there or in the session's recorded directory:
// Codex and Claude Code look the id up across every project, and OMP switches itself into
// the recorded directory when it still exists.
export async function resumeSession(session, configDir, {
  origin,
  dangerousMode = false,
  leanMode = false,
  ompLeanSkills = [],
  codexRunner = runCodex,
  claudeRunner = runClaude,
  ompRunner = runOmp,
} = {}) {
  if (session?.agent === "codex") {
    const options = { configDir };
    if (origin) options.origin = origin;
    if (dangerousMode) options.dangerousMode = true;
    return codexRunner(["resume", session.id], options);
  }
  if (session?.agent === "claude") {
    const options = { configDir };
    if (origin) options.origin = origin;
    if (dangerousMode) options.dangerousMode = true;
    return claudeRunner(["--resume", session.id], options);
  }
  if (session?.agent === "omp") {
    const options = { configDir, leanMode, ompLeanSkills };
    if (origin) options.origin = origin;
    if (dangerousMode) options.dangerousMode = true;
    return ompRunner([`--resume=${session.id}`], options);
  }
  throw new Error(`Unsupported session agent: ${session?.agent ?? "unknown"}`);
}

function printHelp() {
  console.log(`Usage:
  zgap login             Choose OAuth or API key
  zgap login oauth       Sign in through browser OAuth
  zgap login api         Configure a static proxy API key
  zgap logout            Sign out on this device
  zgap codex [args...]   Run Codex through the configured proxy
  zgap claude [args...]  Run Claude through the configured proxy
  zgap omp [args...]     Run OMP through the configured proxy
  zgap resume          Resume an agent session
  zgap serve [--port N]  Forward a loopback port to the proxy for local-only clients
  zgap update            Update zgap from GitHub main

zgap keeps each supported agent's normal local configuration and history.`);
}

export async function main({
  argv = process.argv.slice(2),
  configDir = defaultConfigDir(),
  credentialStateReader = readCredentialState,
  credentialReader = readCredentialFile,
  apiKeyReader = readApiKey,
  apiKeySaver = saveApiKey,
  loginRunner = login,
  loginMenu = runLoginMenu,
  startMenu = runStartMenu,
  sessionBrowser = runSessionBrowser,
  updateChecker = checkForGlobalUpdate,
  configReader = readProxyConfig,
  dangerousModeReader = readDangerousMode,
  dangerousModeWriter = writeDangerousMode,
  ompSkillsLoader = discoverOmpSkills,
  ompLeanSkillsReader = readOmpLeanSkills,
  ompLeanSkillsWriter = writeOmpLeanSkills,
  codexRunner = runCodex,
  claudeRunner = runClaude,
  ompRunner = runOmp,
  serveRunner = runServe,
  log = console.log,
  cwd = process.cwd(),
} = {}) {
  const [command, ...args] = argv;
  const runLoginCommand = async (loginArgs, knownProxyConfig) => {
    if (loginArgs.length > 1 || (loginArgs.length === 1 && !["oauth", "api"].includes(loginArgs[0]))) {
      throw new Error("`zgap login` accepts only `oauth` or `api`.");
    }
    let proxyConfig = knownProxyConfig;
    let method = loginArgs[0];
    if (method === undefined) {
      proxyConfig ??= await configReader(configDir);
      method = await loginMenu({ host: proxyConfig.host, origin: proxyConfig.origin });
    }
    if (typeof method === "number") return method;
    if (method === "oauth") {
      const origin = proxyConfig?.origin ?? (await configReader(configDir)).origin;
      await loginRunner({ configDir, origin });
      return 0;
    }
    if (method === "api") {
      await apiKeySaver({ configDir, apiKey: await apiKeyReader() });
      log("Static API key configured.");
      return 0;
    }
    throw new Error("Login menu returned an invalid authentication method.");
  };
  if (command === "login") return runLoginCommand(args);
  if (command === "logout") {
    await logout({ configDir });
    log("Logged out.");
    return 0;
  }
  if (command === "codex") {
    const [{ origin }, dangerousMode] = await Promise.all([
      configReader(configDir),
      dangerousModeReader(configDir),
    ]);
    return codexRunner(args, { configDir, origin, dangerousMode });
  }
  if (command === "claude") {
    const [{ origin }, dangerousMode] = await Promise.all([
      configReader(configDir),
      dangerousModeReader(configDir),
    ]);
    return claudeRunner(args, { configDir, origin, dangerousMode });
  }
  if (command === "omp") {
    const [{ origin }, dangerousMode] = await Promise.all([
      configReader(configDir),
      dangerousModeReader(configDir),
    ]);
    return ompRunner(args, {
      configDir,
      origin,
      dangerousMode,
    });
  }
  if (command === "serve") {
    const { origin } = await configReader(configDir);
    return serveRunner(args, { configDir, origin, log });
  }
  if (command === "resume") {
    const [{ host, origin }, dangerousMode] = await Promise.all([
      configReader(configDir),
      dangerousModeReader(configDir),
    ]);
    return sessionBrowser({
      cwd,
      host,
      onSelect: async (session, { remote = true } = {}) => {
        return resumeSession(session, configDir, {
          ...(remote ? { origin } : {}),
          dangerousMode,
          codexRunner,
          claudeRunner,
          ompRunner,
        });
      },
    });
  }
  if (command === "update") {
    return updateGlobalInstall();
  }
  if (!command) {
    const proxyConfig = await configReader(configDir);
    let [dangerousMode, ompLeanSkills] = await Promise.all([
      dangerousModeReader(configDir),
      ompLeanSkillsReader(configDir),
    ]);
    let ompLeanMode = false;
    while (true) {
      const credentialFile = credentialsPath(configDir);
      const credentialState = await credentialStateReader({
        credentialFile,
      });
      let accountProfile;
      if (credentialState === "signed-in") {
        try {
          const credential = await credentialReader(credentialFile);
          accountProfile = decodeAccessTokenProfile(credential.access_token, credential.origin);
        } catch {
          accountProfile = null;
        }
      }
      const menuResult = await startMenu({
        credentialState,
        accountProfile,
        host: proxyConfig.host,
        origin: proxyConfig.origin,
        updateChecker: (options) => updateChecker({ ...options, configDir }),
        dangerousMode,
        ompLeanMode,
        ompLeanSkills,
        onOmpSkillsLoad: () => ompSkillsLoader({ cwd }),
        onDangerousModeChange: async (enabled) => {
          await dangerousModeWriter(enabled, configDir);
          dangerousMode = enabled;
        },
        onOmpLeanModeChange: (enabled) => {
          ompLeanMode = enabled;
        },
        onOmpLeanSkillsChange: async (skills) => {
          await ompLeanSkillsWriter(skills, configDir);
          ompLeanSkills = skills;
        },
        actions: {
          login: () => runLoginCommand([], proxyConfig),
          codex: () => codexRunner([], { configDir, origin: proxyConfig.origin, dangerousMode }),
          claude: () => claudeRunner([], { configDir, origin: proxyConfig.origin, dangerousMode }),
          omp: () => ompRunner([], {
            configDir,
            origin: proxyConfig.origin,
            dangerousMode,
            leanMode: ompLeanMode,
            ...(ompLeanSkills.length > 0 ? { ompLeanSkills } : {}),
          }),
          resume: async () => {
            let selected = false;
            const browserResult = await sessionBrowser({
              cwd,
              host: proxyConfig.host,
              onSelect: (session, { remote = true } = {}) => {
                selected = true;
                return resumeSession(session, configDir, {
                  ...(remote ? { origin: proxyConfig.origin } : {}),
                  dangerousMode,
                  leanMode: ompLeanMode,
                  ompLeanSkills,
                  codexRunner,
                  claudeRunner,
                  ompRunner,
                });
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
