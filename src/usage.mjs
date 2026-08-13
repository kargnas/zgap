import { REQUEST_TIMEOUT_MS } from "./constants.mjs";
import { readCredentialFile, resolveAccessToken } from "./credentials.mjs";

const USAGE_FIELDS = [
  "request_count",
  "total_tokens",
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
];

function validateUsage(body) {
  if (
    !body
    || typeof body !== "object"
    || Array.isArray(body)
    || body.plan_type !== "ai-proxy1"
  ) {
    throw new Error("Usage response returned an invalid response.");
  }
  for (const field of USAGE_FIELDS) {
    if (!Number.isSafeInteger(body[field]) || body[field] < 0) {
      throw new Error("Usage response returned an invalid response.");
    }
  }
  if (body.total_tokens !== body.input_tokens + body.output_tokens) {
    throw new Error("Usage response returned an invalid response.");
  }
  return body;
}

export async function fetchCurrentUserUsage({
  credentialFile,
  fetchImpl = fetch,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const credential = await readCredentialFile(credentialFile);
  const accessToken = await resolveAccessToken({ credentialFile, fetchImpl, requestTimeoutMs });
  const response = await fetchImpl(new URL("/api/codex/usage", credential.origin), {
    method: "GET",
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Usage request failed (${response.status}).`);
  return validateUsage(body);
}
