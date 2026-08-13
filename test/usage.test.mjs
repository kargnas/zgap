import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const ACCESS_TOKEN = `zgap-at-${"a".repeat(43)}`;

test("current user usage는 저장된 access token으로 문서화된 self endpoint를 호출한다", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zgap-usage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentialFile = path.join(directory, "credentials.json");
  await writeFile(credentialFile, JSON.stringify({
    access_expires_at: "2099-01-02T00:00:00.000Z",
    access_token: ACCESS_TOKEN,
    device_id: "d".repeat(43),
    origin: "https://example.test",
    refresh_expires_at: "2099-01-05T00:00:00.000Z",
    refresh_token: `zgap-rt-${"b".repeat(43)}`,
  }));

  let request;
  const usage = { plan_type: "ai-proxy1", request_count: 12, total_tokens: 1500, input_tokens: 1000, output_tokens: 500, cached_input_tokens: 200, cache_creation_input_tokens: 0 };
  const { fetchCurrentUserUsage } = await import("../src/usage.mjs");
  const result = await fetchCurrentUserUsage({
    credentialFile,
    fetchImpl: async (url, options) => {
      request = { url: url.toString(), options };
      return new Response(JSON.stringify(usage), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.deepEqual(result, usage);
  assert.equal(request.url, "https://example.test/api/codex/usage");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.ok(request.options.signal instanceof AbortSignal);
});

test("current user usage는 실패 응답과 문서 계약 밖 payload를 거부한다", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zgap-usage-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentialFile = path.join(directory, "credentials.json");
  await writeFile(credentialFile, JSON.stringify({
    access_expires_at: "2099-01-02T00:00:00.000Z",
    access_token: ACCESS_TOKEN,
    device_id: "d".repeat(43),
    origin: "https://example.test",
    refresh_expires_at: "2099-01-05T00:00:00.000Z",
    refresh_token: `zgap-rt-${"b".repeat(43)}`,
  }));
  const { fetchCurrentUserUsage } = await import("../src/usage.mjs");

  await assert.rejects(
    fetchCurrentUserUsage({
      credentialFile,
      fetchImpl: async () => new Response('{"error":"invalid_api_key"}', { status: 401 }),
    }),
    /Usage request failed \(401\)/,
  );
  await assert.rejects(
    fetchCurrentUserUsage({
      credentialFile,
      fetchImpl: async () => new Response(JSON.stringify({
        plan_type: "unexpected",
        request_count: 1,
        total_tokens: 3,
        input_tokens: 1,
        output_tokens: 2,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
      })),
    }),
    /Usage response returned an invalid response/,
  );
});
