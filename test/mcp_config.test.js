import test from "node:test";
import assert from "node:assert/strict";
import { assertConfigured, loadMcpConfig } from "../mcp/config.js";

test("loadMcpConfig rejects insecure http by default", () => {
  assert.throws(
    () =>
      loadMcpConfig({
        WP_BASE_URL: "http://example.com"
      }),
    /must use https/i
  );
});

test("loadMcpConfig allows insecure http only with explicit flag", () => {
  const out = loadMcpConfig({
    WP_BASE_URL: "http://example.com",
    WP_ALLOW_INSECURE_HTTP: "true"
  });
  assert.equal(out.baseUrl, "http://example.com");
  assert.equal(out.allowInsecureHttp, true);
});

test("loadMcpConfig normalizes https base url and timeout fallback", () => {
  const out = loadMcpConfig({
    WP_BASE_URL: "https://example.com/anything",
    WP_TIMEOUT_MS: "0"
  });
  assert.equal(out.baseUrl, "https://example.com");
  assert.equal(out.timeoutMs, 15000);
});

test("assertConfigured validates required credentials", () => {
  assert.throws(
    () =>
      assertConfigured({
        baseUrl: "",
        username: "u",
        appPassword: "p"
      }),
    /Missing WordPress credentials/
  );

  assert.doesNotThrow(() =>
    assertConfigured({
      baseUrl: "https://example.com",
      username: "u",
      appPassword: "p"
    })
  );
});
