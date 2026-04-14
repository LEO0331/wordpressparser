import test from "node:test";
import assert from "node:assert/strict";
import { WordPressClient } from "../mcp/wp-client.js";

function buildResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    }
  };
}

test("resolveVersion falls back to v2 with warning", async () => {
  const calls = [];
  const mockFetch = async (url) => {
    calls.push(url);
    if (String(url).includes("/wp-json/wp/v3/posts")) {
      return buildResponse(404, { message: "not found" });
    }
    return buildResponse(200, [{ id: 1, title: { rendered: "hello" }, status: "publish" }]);
  };

  const client = new WordPressClient({
    baseUrl: "https://example.com",
    username: "u",
    appPassword: "p",
    preferredVersion: "v3",
    fetchImpl: mockFetch
  });

  const out = await client.listPosts({ per_page: 1 });
  assert.equal(out.version, "v2");
  assert.ok(String(out.warning).includes("Falling back to 'v2'"));
  assert.ok(calls.some((x) => String(x).includes("/wp-json/wp/v3/posts")));
  assert.ok(calls.some((x) => String(x).includes("/wp-json/wp/v2/posts")));
});

test("publishPost requires confirm=true", async () => {
  const client = new WordPressClient({
    baseUrl: "https://example.com",
    username: "u",
    appPassword: "p",
    preferredVersion: "v2",
    fetchImpl: async () => buildResponse(200, {})
  });

  await assert.rejects(() => client.publishPost(123, false), /confirm=true/);
});
