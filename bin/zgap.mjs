#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = "https://ai-proxy.zz.gg";
const API_BASE_URL = `${ORIGIN}/v1`;
const CLIENT_ID = "zgap";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const AUTH_SCRIPT = 'const{readFileSync}=require("node:fs");const value=JSON.parse(readFileSync(process.argv[1],"utf8"));process.stdout.write(value.access_token)';
const MANAGED_PROVIDER_COMMENT = "# Managed by zgap so Codex App can resume zgap sessions.";

function defaultConfigDir() {
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, "zgap");
  if (process.platform === "win32" && process.env.APPDATA) return path.join(process.env.APPDATA, "zgap");
  return path.join(os.homedir(), ".config", "zgap");
}

function credentialsPath(configDir) {
  return path.join(configDir, "credentials.json");
}

async function saveCredentials(configDir, accessToken) {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const target = credentialsPath(configDir);
  const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ access_token: accessToken })}\n`, { mode: 0o600 });
  await rename(temporary, target);
  if (process.platform !== "win32") {
    await chmod(configDir, 0o700);
    await chmod(target, 0o600);
  }
}

async function readCredentials(configDir) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(credentialsPath(configDir), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("Not logged in. Run `zgap login` first.");
    throw new Error(`Cannot read zgap credentials: ${error.message}`);
  }
  if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
    throw new Error("Invalid zgap credentials. Run `zgap login` again.");
  }
  return parsed;
}

function providerTable(credentialFile, spaced = false) {
  const quote = JSON.stringify;
  if (spaced) {
    return `{ name = ${quote("zgap")}, base_url = ${quote(API_BASE_URL)}, auth = { command = ${quote(process.execPath)}, args = [${quote("-e")}, ${quote(AUTH_SCRIPT)}, ${quote(credentialFile)}] } }`;
  }
  return `{name=${quote("zgap")},base_url=${quote(API_BASE_URL)},auth={command=${quote(process.execPath)},args=[${quote("-e")},${quote(AUTH_SCRIPT)},${quote(credentialFile)}]}}`;
}

async function installCodexProvider(codexHome, credentialFile) {
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const configPath = path.join(codexHome, "config.toml");
  let current = "";
  let mode = 0o600;
  try {
    current = await readFile(configPath, "utf8");
    mode = (await stat(configPath)).mode & 0o777;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const providerLine = `model_providers.zgap = ${providerTable(credentialFile, true)}`;
  const lines = current.split("\n");
  const markerIndexes = lines.flatMap((line, index) => line === MANAGED_PROVIDER_COMMENT ? [index] : []);
  if (markerIndexes.length > 1) throw new Error("Codex config contains duplicate zgap provider blocks.");
  if (markerIndexes.length === 1) {
    const index = markerIndexes[0];
    if (!/^model_providers\.zgap\s*=/.test(lines[index + 1] ?? "")) {
      throw new Error("Codex config contains a damaged zgap provider block.");
    }
    lines[index + 1] = providerLine;
  } else {
    if (lines.some((line) => /^\s*model_providers\.zgap\s*=|^\s*\[model_providers\.zgap(?:\.|\])/.test(line))) {
      throw new Error("Codex config already defines model provider `zgap` outside the managed block.");
    }
    const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
    const index = firstTable === -1 ? lines.length : firstTable;
    lines.splice(index, 0, MANAGED_PROVIDER_COMMENT, providerLine, "");
  }

  const temporary = `${configPath}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, lines.join("\n"), { mode });
  await rename(temporary, configPath);
  if (process.platform !== "win32") await chmod(configPath, mode);
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function defaultOpenBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

export async function login({
  codexHome = path.join(os.homedir(), ".codex"),
  configDir = defaultConfigDir(),
  origin = ORIGIN,
  timeoutMs = LOGIN_TIMEOUT_MS,
  openBrowser = defaultOpenBrowser,
  log = console.log,
} = {}) {
  const normalizedOrigin = new URL(origin).origin;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(32).toString("base64url");
  let resolveCode;
  let rejectCode;
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const callbackServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code");
    if (url.searchParams.get("state") !== state || !code) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Invalid OAuth callback.");
      return;
    }
    response.writeHead(200, {
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "content-type": "text/html; charset=utf-8",
    });
    response.end("<!doctype html><meta charset=utf-8><title>zgap</title><p>Authorization received. Return to the terminal.</p>");
    resolveCode(code);
  });
  callbackServer.on("error", rejectCode);
  callbackServer.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    callbackServer.once("listening", resolve);
    callbackServer.once("error", reject);
  });

  const address = callbackServer.address();
  const redirectUri = `http://127.0.0.1:${address.port}/callback`;
  const authorizeUrl = new URL("/console/cli-auth", normalizedOrigin);
  authorizeUrl.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  }).toString();
  log(`Open this URL to sign in:\n${authorizeUrl}`);

  const timer = setTimeout(() => rejectCode(new Error("Login timed out.")), timeoutMs);
  try {
    await openBrowser(authorizeUrl.toString());
    const code = await codePromise;
    const tokenResponse = await fetch(new URL("/cli/oauth/token", normalizedOrigin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code,
        code_verifier: verifier,
      }),
    });
    const body = await tokenResponse.json().catch(() => null);
    if (!tokenResponse.ok) throw new Error(`Token exchange failed (${tokenResponse.status}).`);
    if (body?.token_type !== "Bearer" || typeof body.access_token !== "string" || body.access_token.length === 0) {
      throw new Error("Token exchange returned an invalid response.");
    }
    await saveCredentials(configDir, body.access_token);
    await installCodexProvider(codexHome, credentialsPath(configDir));
    log("Logged in. Run `zgap codex`.");
  } finally {
    clearTimeout(timer);
    await closeServer(callbackServer);
  }
}

function providerConfig(credentialFile) {
  return `model_providers.zgap=${providerTable(credentialFile)}`;
}

export async function runCodex(args, { configDir = defaultConfigDir() } = {}) {
  await readCredentials(configDir);
  const env = { ...process.env };
  delete env.CODEX_HOME;
  delete env.OPENAI_BASE_URL;
  delete env.OPENAI_API_KEY;
  delete env.ZGAP_API_KEY;

  const child = spawn("codex", [
    "-c",
    providerConfig(credentialsPath(configDir)),
    "-c",
    'model_provider="zgap"',
    ...args,
  ], { env, stdio: "inherit" });

  return await new Promise((resolve, reject) => {
    child.once("error", (error) => {
      if (error.code === "ENOENT") reject(new Error("Codex CLI is not installed or not in PATH."));
      else reject(error);
    });
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

function printHelp() {
  console.log(`Usage:
  zgap login             Sign in with ai-proxy.zz.gg
  zgap codex [args...]   Run Codex through ai-proxy.zz.gg

zgap uses your normal ~/.codex directory, so Codex App and CLI share history.`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "login") {
    await login();
    return 0;
  }
  if (command === "codex") return runCodex(args);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(`zgap: ${error.message}`);
      process.exitCode = 1;
    },
  );
}
