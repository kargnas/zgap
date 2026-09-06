import assert from "node:assert/strict";
import http from "node:http";
import { test } from "./harness.mjs";
import { createForwarder, DEFAULT_SERVE_PORT, parseServeArgs } from "../src/serve.mjs";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));

test("serve 옵션은 --port, -p, --port=만 받는다", () => {
  assert.deepEqual(parseServeArgs([]), { port: DEFAULT_SERVE_PORT });
  assert.deepEqual(parseServeArgs(["--port", "1234"]), { port: 1234 });
  assert.deepEqual(parseServeArgs(["-p", "1234"]), { port: 1234 });
  assert.deepEqual(parseServeArgs(["--port=1234"]), { port: 1234 });
  assert.throws(() => parseServeArgs(["--port", "70000"]), /between 1 and 65535/);
  assert.throws(() => parseServeArgs(["--port"]), /between 1 and 65535/);
  assert.throws(() => parseServeArgs(["--yolo"]), /Unknown serve option/);
});

test("포워더는 클라이언트 인증을 버리고 zgap 토큰으로 요청을 그대로 넘기며 스트림을 중계한다", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, apiKey: req.headers["x-api-key"], accept: req.headers.accept, body });
      res.writeHead(201, { "content-type": "text/event-stream", "x-upstream": "yes" });
      res.write("data: one\n\n");
      setTimeout(() => res.end("data: two\n\n"), 20);
    });
  });
  const origin = await listen(upstream);
  t.after(() => upstream.close());
  const forwarder = createForwarder({ origin, resolveToken: async () => "tok-1" });
  const base = await listen(forwarder);
  t.after(() => forwarder.close());

  const response = await fetch(`${base}/v1/chat/completions?x=1`, {
    method: "POST",
    headers: { authorization: "Bearer placeholder", "x-api-key": "placeholder", accept: "text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ model: "m" }),
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-upstream"), "yes");
  assert.equal(await response.text(), "data: one\n\ndata: two\n\n");
  assert.deepEqual(seen, [{ method: "POST", url: "/v1/chat/completions?x=1", authorization: "Bearer tok-1", apiKey: undefined, accept: "text/event-stream", body: '{"model":"m"}' }]);
});

test("토큰을 얻지 못하면 upstream에 닿지 않고 502로 끝낸다", async (t) => {
  let hits = 0;
  const upstream = http.createServer((_req, res) => { hits += 1; res.end(); });
  const origin = await listen(upstream);
  t.after(() => upstream.close());
  const forwarder = createForwarder({ origin, resolveToken: async () => { throw new Error("zgap session expired. Run `zgap login` again."); } });
  const base = await listen(forwarder);
  t.after(() => forwarder.close());

  const response = await fetch(`${base}/api/tags`);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error.message, /zgap login/);
  assert.equal(hits, 0);
});

test("serve 명령은 설정된 origin과 인자를 포워더 실행기에 넘긴다", async () => {
  const { main } = await import("../src/cli.mjs");
  let received;
  const code = await main({
    argv: ["serve", "--port", "1234"],
    configDir: "/tmp/zgap-config",
    configReader: async () => ({ host: "proxy.example.test", origin: "https://proxy.example.test" }),
    serveRunner: async (args, options) => { received = { args, options }; return 0; },
  });
  assert.equal(code, 0);
  assert.deepEqual(received.args, ["--port", "1234"]);
  assert.equal(received.options.origin, "https://proxy.example.test");
  assert.equal(received.options.configDir, "/tmp/zgap-config");
});
