import { randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  DEVICE_ID_RE,
  LOCK_STALE_MS,
  LOCK_TIMEOUT_MS,
  REFRESH_REQUIRED_MS,
  REFRESH_START_MS,
  REFRESH_TOKEN_RE,
  REQUEST_TIMEOUT_MS,
  CLIENT_ID,
  MAX_ACCESS_TOKEN_SIZE,
  ORIGIN,
} from "./constants.mjs";

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const REQUIRED_AUDIENCES = ["https://ai-proxy.zz.gg"];

function decodeJsonSegment(segment) {
  if (!BASE64URL_RE.test(segment) || segment.length % 4 === 1) return null;
  try {
    const bytes = Buffer.from(segment, "base64url");
    if (bytes.toString("base64url") !== segment) return null;
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { return null; }
}

function validEncodedSegment(segment) {
  if (!segment || !BASE64URL_RE.test(segment) || segment.length % 4 === 1) return false;
  try {
    const bytes = Buffer.from(segment, "base64url");
    return bytes.toString("base64url") === segment;
  } catch { return false; }
}

const SAFE_CLAIM_RE = /^(?!.*[\u0000-\u001F\u007F-\u009F])[\s\S]+$/;
function safeClaim(value, maxLength) { return typeof value === "string" && value.length > 0 && value.length <= maxLength && SAFE_CLAIM_RE.test(value); }

function validHttpsOrigin(value) {
  try {
    const parsed = new URL(value);
    return typeof value === "string" && parsed.protocol === "https:" && parsed.origin === value && !parsed.username && !parsed.password;
  } catch { return false; }
}

export function decodeAccessTokenProfile(token) {
  if (typeof token !== "string" || token.length > MAX_ACCESS_TOKEN_SIZE) return null;
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => !validEncodedSegment(segment))) return null;
  const [header, payload] = segments.map(decodeJsonSegment);
  if (
    !header || typeof header !== "object" || Array.isArray(header) || header.alg !== "EdDSA" || header.typ !== "JWT"
    || !payload || typeof payload !== "object" || Array.isArray(payload)
    || payload.iss !== "https://ai-proxy.zz.gg"
    || !Array.isArray(payload.aud) || !REQUIRED_AUDIENCES.every((audience) => payload.aud.includes(audience))
    || typeof payload.sub !== "string" || !/^\d+$/.test(payload.sub)
    || typeof payload.sid !== "string" || !/^\d+$/.test(payload.sid)
    || !safeClaim(payload.email, 320) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)
    || typeof payload.email_verified !== "boolean"
    || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.exp <= payload.iat
    || !Array.isArray(payload.proxy_products) || payload.proxy_products.length === 0
    || payload.proxy_products.some((product) => !product || typeof product !== "object" || Array.isArray(product)
      || !safeClaim(product.id, 64) || !validHttpsOrigin(product.origin))
  ) return null;
  return {
    email: payload.email,
    emailVerified: payload.email_verified,
    proxyProducts: payload.proxy_products.map(({ id, origin }) => ({ id, origin })),
  };
}

export function defaultConfigDir() {
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, "zgap");
  if (process.platform === "win32" && process.env.APPDATA) return path.join(process.env.APPDATA, "zgap");
  return path.join(os.homedir(), ".config", "zgap");
}

export function credentialsPath(configDir) {
  return path.join(configDir, "credentials.json");
}

export async function writePrivateJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  if (process.platform !== "win32") {
    await chmod(path.dirname(target), 0o700);
    await chmod(target, 0o600);
  }
}

function normalizeCredential(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const accessExpiresAt = Date.parse(parsed.access_expires_at);
  const refreshExpiresAt = Date.parse(parsed.refresh_expires_at);
  let origin;
  try {
    origin = new URL(parsed.origin).origin;
  } catch {
    origin = null;
  }
  if (
    !decodeAccessTokenProfile(parsed.access_token)
    || typeof parsed.refresh_token !== "string"
    || !REFRESH_TOKEN_RE.test(parsed.refresh_token)
    || typeof parsed.device_id !== "string"
    || !DEVICE_ID_RE.test(parsed.device_id)
    || !Number.isFinite(accessExpiresAt)
    || !Number.isFinite(refreshExpiresAt)
    || origin !== parsed.origin || origin !== ORIGIN
  ) return null;
  return { ...parsed, accessExpiresAt, refreshExpiresAt };
}

export async function readCredentialFile(target) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("Not logged in. Run `zgap login` first.");
    throw new Error(`Cannot read zgap credentials: ${error.message}`);
  }
  const credential = normalizeCredential(parsed);
  if (!credential) throw new Error("Invalid zgap credentials. Run `zgap login` again.");
  return credential;
}

export async function readCredentialState({ credentialFile, now = Date.now } = {}) {
  let source;
  try {
    source = await readFile(credentialFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "signed-out";
    throw new Error(`Cannot read zgap credentials: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return "signed-out";
  }
  const credential = normalizeCredential(parsed);
  if (!credential) return "signed-out";
  return credential.refreshExpiresAt <= now() ? "expired" : "signed-in";
}

export async function deviceIdFor(configDir) {
  try {
    const parsed = JSON.parse(await readFile(credentialsPath(configDir), "utf8"));
    if (typeof parsed.device_id === "string" && DEVICE_ID_RE.test(parsed.device_id)) return parsed.device_id;
  } catch {
    // 첫 로그인이나 깨진 옛 credential은 새 device id로 완전히 교체한다.
  }
  return randomBytes(32).toString("base64url");
}

async function lockOwnerIsRunning(lockFile) {
  let ownerPid;
  try {
    ownerPid = Number((await readFile(lockFile, "utf8")).trim().split(":", 1)[0]);
  } catch (error) {
    return error?.code !== "ENOENT";
  }
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return false;
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    // A process hidden by OS permissions may still own the lock; only ESRCH proves it exited.
    return error?.code !== "ESRCH";
  }
}

export async function withCredentialLock(credentialFile, operation) {
  const lockFile = `${credentialFile}.lock`;
  const owner = `${process.pid}:${randomBytes(8).toString("hex")}\n`;
  const candidate = `${lockFile}.${randomBytes(8).toString("hex")}.tmp`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let ownsLock = false;
  await writeFile(candidate, owner, { flag: "wx", mode: 0o600 });
  try {
    while (!ownsLock) {
      try {
        // link() publishes the prepared owner record atomically, so a paused owner is never mistaken for a crashed one.
        await link(candidate, lockFile);
        ownsLock = true;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const lockStat = await lstat(lockFile).catch((statError) => {
          if (statError?.code === "ENOENT") return null;
          throw statError;
        });
        if (lockStat && !lockStat.isFile()) throw new Error("Invalid zgap credential lock.");
        if (
          lockStat
          && Date.now() - lockStat.mtimeMs > LOCK_STALE_MS
          && !await lockOwnerIsRunning(lockFile)
        ) {
          await rm(lockFile, { force: true });
          continue;
        }
        if (Date.now() >= deadline) throw new Error("Timed out waiting for zgap credential refresh.");
        await delay(25);
      }
    }
    return await operation();
  } finally {
    await rm(candidate, { force: true });
    if (ownsLock) {
      let currentOwner;
      try {
        currentOwner = await readFile(lockFile, "utf8");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (currentOwner === owner) await rm(lockFile, { force: true });
    }
  }
}

export async function logout({ configDir = defaultConfigDir() } = {}) {
  const credentialFile = credentialsPath(configDir);
  try {
    await stat(configDir);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  // Wait for an active token rotation, then delete its final credential so logout cannot be undone by that refresh.
  await withCredentialLock(credentialFile, () => rm(credentialFile, { force: true }));
}

export async function resolveAccessToken({
  credentialFile,
  fetchImpl = fetch,
  now = Date.now,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const current = await readCredentialFile(credentialFile);
  if (current.accessExpiresAt - now() > REFRESH_START_MS) return current.access_token;

  return withCredentialLock(credentialFile, async () => {
    // 다른 Codex process가 lock을 잡고 먼저 rotation했으면 새 파일을 그대로 쓴다.
    const credential = await readCredentialFile(credentialFile);
    const timestamp = now();
    const accessRemainingMs = credential.accessExpiresAt - timestamp;
    if (accessRemainingMs > REFRESH_START_MS) return credential.access_token;
    if (credential.refreshExpiresAt <= timestamp) throw new Error("zgap session expired. Run `zgap login` again.");

    let response;
    try {
      response = await fetchImpl(new URL("/cli/oauth/token", credential.origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: credential.refresh_token,
        }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      // The still-valid JWT keeps the CLI usable while a transient network failure clears.
      if (accessRemainingMs > REFRESH_REQUIRED_MS) return credential.access_token;
      throw error;
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status >= 500 && accessRemainingMs > REFRESH_REQUIRED_MS) return credential.access_token;
      const loginHint = response.status >= 400 && response.status < 500 ? " Run `zgap login` again." : "";
      throw new Error(`Token refresh failed (${response.status}).${loginHint}`);
    }
    if (
      body?.token_type !== "Bearer"
      || !decodeAccessTokenProfile(body.access_token)
      || typeof body.refresh_token !== "string"
      || !REFRESH_TOKEN_RE.test(body.refresh_token)
      || !Number.isFinite(body.expires_in)
      || body.expires_in <= 0
      || !Number.isFinite(body.refresh_expires_in)
      || body.refresh_expires_in <= 0
    ) {
      throw new Error("Token refresh returned an invalid response. Run `zgap login` again.");
    }
    const next = {
      access_expires_at: new Date(timestamp + body.expires_in * 1000).toISOString(),
      access_token: body.access_token,
      device_id: credential.device_id,
      origin: credential.origin,
      refresh_expires_at: new Date(timestamp + body.refresh_expires_in * 1000).toISOString(),
      refresh_token: body.refresh_token,
    };
    await writePrivateJson(credentialFile, next);
    return next.access_token;
  });
}
