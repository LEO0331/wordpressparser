import test from "node:test";
import assert from "node:assert/strict";
import { loadMcpConfig } from "../mcp/config.js";

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
