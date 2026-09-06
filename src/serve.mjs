import http from "node:http";
import https from "node:https";
import { ORIGIN } from "./constants.mjs";
import { credentialsPath, defaultConfigDir, readCredentialState, resolveAccessToken } from "./credentials.mjs";

// Ollama's default port, so a client's prefilled `http://localhost:11434/v1` works unchanged.
export const DEFAULT_SERVE_PORT = 11434;
// Loopback only. The forwarder exists because local-only clients (Aside's Ollama and
// LM Studio connections, for example) reject every non-loopback host before sending a
// request; binding wider would also hand the zgap credential to the LAN.
const SERVE_HOST = "127.0.0.1";
// Client credentials are dropped, not forwarded: the proxy credential is zgap's, and the
// client's key field holds whatever placeholder its form required.
const DROPPED_REQUEST_HEADERS = new Set([
  "host", "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer",
  "authorization", "x-api-key",
]);
// Node re-frames the relayed body itself, so the upstream framing headers must not leak.
const DROPPED_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding"]);

export function parseServeArgs(args) {
  let port = DEFAULT_SERVE_PORT;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    let value;
    if (arg === "--port" || arg === "-p") {
      index += 1;
      value = args[index];
    } else if (arg.startsWith("--port=")) {
      value = arg.slice("--port=".length);
    } else {
      throw new Error(`Unknown serve option: ${arg}`);
    }
    if (!/^\d{1,5}$/.test(value ?? "") || Number(value) < 1 || Number(value) > 65535) {
      throw new Error("`--port` requires a number between 1 and 65535.");
    }
    port = Number(value);
  }
  return { port };
}

function jsonError(res, status, message) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message } }));
}

export function createForwarder({ origin, resolveToken }) {
  const target = new URL(origin);
  const transport = target.protocol === "https:" ? https : http;
  return http.createServer(async (req, res) => {
    let token;
    try {
      token = await resolveToken();
    } catch (error) {
      req.resume();
      jsonError(res, 502, `zgap serve: ${error.message}`);
      return;
    }
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!DROPPED_REQUEST_HEADERS.has(name)) headers[name] = value;
    }
    headers.authorization = `Bearer ${token}`;
    const upstream = transport.request({
      hostname: target.hostname,
      port: target.port || undefined,
      path: req.url,
      method: req.method,
      headers,
    }, (response) => {
      const responseHeaders = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (!DROPPED_RESPONSE_HEADERS.has(name)) responseHeaders[name] = value;
      }
      res.writeHead(response.statusCode, responseHeaders);
      // Streams (SSE) relay chunk by chunk; nothing buffers the whole body.
      response.pipe(res);
    });
    upstream.once("error", (error) => {
      if (res.headersSent) res.destroy();
      else jsonError(res, 502, `zgap serve: ${error.message}`);
    });
    req.pipe(upstream);
  });
}

export async function runServe(args, { configDir = defaultConfigDir(), origin = ORIGIN, log = console.log } = {}) {
  const { port } = parseServeArgs(args);
  const credentialFile = credentialsPath(configDir);
  if (await readCredentialState({ credentialFile }) !== "signed-in") {
    throw new Error("Not signed in. Run `zgap login` first.");
  }
  // resolveAccessToken refreshes near expiry, so every request carries a live token.
  const server = createForwarder({ origin, resolveToken: () => resolveAccessToken({ credentialFile }) });
  await new Promise((resolve, reject) => {
    server.once("error", (error) => reject(error.code === "EADDRINUSE"
      ? new Error(`Port ${port} is already in use (a local Ollama or another zgap serve?). Choose another with --port.`)
      : error));
    server.listen(port, SERVE_HOST, resolve);
  });
  log(`zgap serve: http://${SERVE_HOST}:${port} -> ${origin}
Base URL for local-only clients: http://${SERVE_HOST}:${port}/v1
Press Ctrl+C to stop.`);
  return new Promise((resolve) => {
    const stop = () => {
      server.closeAllConnections?.();
      server.close(() => resolve(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
