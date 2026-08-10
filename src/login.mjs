import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  CLIENT_ID,
  ACCESS_TOKEN_RE,
  REFRESH_TOKEN_RE,
  LOGIN_TIMEOUT_MS,
  ORIGIN,
  REQUEST_TIMEOUT_MS,
} from "./constants.mjs";
import { credentialsPath, defaultConfigDir, deviceIdFor, writePrivateJson } from "./credentials.mjs";

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    // Browsers may keep loopback sockets open after the callback response, so close them before returning to the shell.
    server.closeAllConnections();
  });
}

function defaultOpenBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

export async function login({
  configDir = defaultConfigDir(),
  origin = ORIGIN,
  now = Date.now,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  timeoutMs = LOGIN_TIMEOUT_MS,
  openBrowser = defaultOpenBrowser,
  log = console.log,
} = {}) {
  const normalizedOrigin = new URL(origin).origin;
  const deviceId = await deviceIdFor(configDir);
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
    response.writeHead(302, {
      "cache-control": "no-store",
      location: new URL("/console/cli-auth?result=success", normalizedOrigin).toString(),
      "referrer-policy": "no-referrer",
    });
    response.end();
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
    device_id: deviceId,
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
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const body = await tokenResponse.json().catch(() => null);
    if (!tokenResponse.ok) throw new Error(`Token exchange failed (${tokenResponse.status}).`);
    if (
      body?.token_type !== "Bearer"
      || typeof body.access_token !== "string"
      || !ACCESS_TOKEN_RE.test(body.access_token)
      || typeof body.refresh_token !== "string"
      || !REFRESH_TOKEN_RE.test(body.refresh_token)
      || !Number.isFinite(body.expires_in)
      || body.expires_in <= 0
      || !Number.isFinite(body.refresh_expires_in)
      || body.refresh_expires_in <= 0
    ) {
      throw new Error("Token exchange returned an invalid response.");
    }
    const current = now();
    await writePrivateJson(credentialsPath(configDir), {
      access_expires_at: new Date(current + body.expires_in * 1000).toISOString(),
      access_token: body.access_token,
      device_id: deviceId,
      origin: normalizedOrigin,
      refresh_expires_at: new Date(current + body.refresh_expires_in * 1000).toISOString(),
      refresh_token: body.refresh_token,
    });
  } finally {
    clearTimeout(timer);
    await closeServer(callbackServer);
  }
  log("Logged in. Run `zgap codex`.");
}
