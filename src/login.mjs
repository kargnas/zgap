import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  CLIENT_ID,
  REFRESH_TOKEN_RE,
  LOGIN_TIMEOUT_MS,
  ORIGIN,
  REQUEST_TIMEOUT_MS,
} from "./constants.mjs";
import { credentialsPath, decodeAccessTokenProfile, defaultConfigDir, deviceIdFor, writePrivateJson } from "./credentials.mjs";
import { readSystemInfo } from "./system-info.mjs";

function defaultOpenBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

export async function login({
  configDir = defaultConfigDir(),
  now = Date.now,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  timeoutMs = LOGIN_TIMEOUT_MS,
  openBrowser = defaultOpenBrowser,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
} = {}) {
  const deviceId = await deviceIdFor(configDir);
  const systemInfo = await readSystemInfo();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const deadline = Date.now() + timeoutMs;
  const ensureWithinDeadline = () => {
    if (Date.now() >= deadline) throw new Error("Login timed out.");
  };
  const beforeDeadline = async (operation) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Login timed out.");
    let timer;
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Login timed out.")), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const request = async (path, body) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Login timed out.");
    try {
      return await fetchImpl(new URL(path, ORIGIN), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.min(requestTimeoutMs, remaining)),
      });
    } catch (error) {
      if (Date.now() >= deadline) throw new Error("Login timed out.");
      throw error;
    }
  };
  const flow = async () => {
    const authorizationResponse = await request("/cli/oauth/device_authorization", {
      client_id: CLIENT_ID,
      code_challenge: challenge,
      code_challenge_method: "S256",
      device_id: deviceId,
      system_info: systemInfo,
    });
    const authorization = await authorizationResponse.json().catch(() => null);
    let verificationUrl;
    let completeUrl;
    try {
      verificationUrl = new URL(authorization?.verification_uri);
      completeUrl = new URL(authorization?.verification_uri_complete);
    } catch {
      // The response is rejected below with the same public error as other malformed fields.
    }
    if (
      !authorizationResponse.ok
      || typeof authorization?.device_code !== "string"
      || typeof authorization.user_code !== "string"
      || typeof authorization.verification_uri !== "string"
      || typeof authorization.verification_uri_complete !== "string"
      || !Number.isFinite(authorization.expires_in)
      || authorization.expires_in <= 0
      || (authorization.interval !== undefined
        && (!Number.isFinite(authorization.interval) || authorization.interval <= 0))
      || verificationUrl?.origin !== ORIGIN
      || verificationUrl.pathname !== "/console/cli-auth"
      || verificationUrl.search
      || verificationUrl.hash
      || completeUrl?.origin !== ORIGIN
      || completeUrl.pathname !== "/console/cli-auth"
      || completeUrl.searchParams.get("device_code") !== authorization.device_code
      || completeUrl.searchParams.get("user_code") !== authorization.user_code
      || completeUrl.hash
    ) throw new Error("Device authorization returned an invalid response.");

    log(`Open this URL to sign in:\n${authorization.verification_uri_complete}\nCode: ${authorization.user_code}`);
    await beforeDeadline(Promise.resolve().then(() => openBrowser(authorization.verification_uri_complete)));
    let interval = authorization.interval ?? 5;
    const expiresAt = now() + authorization.expires_in * 1000;
    let token;
    while (!token) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Login timed out.");
      await sleep(Math.min(interval * 1000, remaining));
      ensureWithinDeadline();
      if (now() >= expiresAt) throw new Error("Token authorization failed: expired_token");
      const tokenResponse = await request("/cli/oauth/token", {
        client_id: CLIENT_ID,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: authorization.device_code,
        code_verifier: verifier,
      });
      const body = await tokenResponse.json().catch(() => null);
      ensureWithinDeadline();
      if (tokenResponse.ok) {
        if (
          body?.token_type !== "Bearer"
          || !decodeAccessTokenProfile(body.access_token)
          || typeof body.refresh_token !== "string"
          || !REFRESH_TOKEN_RE.test(body.refresh_token)
          || !Number.isFinite(body.expires_in)
          || body.expires_in <= 0
          || !Number.isFinite(body.refresh_expires_in)
          || body.refresh_expires_in <= 0
        ) throw new Error("Token exchange returned an invalid response.");
        token = body;
        break;
      }
      if (body?.error === "authorization_pending") continue;
      if (body?.error === "slow_down") {
        interval += 5;
        continue;
      }
      throw new Error(`Token authorization failed: ${typeof body?.error === "string" ? body.error : "invalid response"}`);
    }

    ensureWithinDeadline();
    const current = now();
    await writePrivateJson(credentialsPath(configDir), {
      access_expires_at: new Date(current + token.expires_in * 1000).toISOString(),
      access_token: token.access_token,
      device_id: deviceId,
      origin: ORIGIN,
      refresh_expires_at: new Date(current + token.refresh_expires_in * 1000).toISOString(),
      refresh_token: token.refresh_token,
    });
  };
  await flow();
  log("Logged in. Run `zgap codex`.");
}
