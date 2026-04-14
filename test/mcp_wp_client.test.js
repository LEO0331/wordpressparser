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

test("request surfaces non-JSON successful responses as explicit errors", async () => {
  const client = new WordPressClient({
    baseUrl: "https://example.com",
    username: "u",
    appPassword: "p",
    preferredVersion: "v2",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return "<html>ok</html>";
      }
    })
  });

  await assert.rejects(() => client.listPosts({ per_page: 1 }), /not valid JSON/);
});

test("readPost validates positive integer id", async () => {
  const client = new WordPressClient({
    baseUrl: "https://example.com",
    username: "u",
    appPassword: "p",
    preferredVersion: "v2",
    fetchImpl: async () => buildResponse(200, [])
  });
  await assert.rejects(() => client.readPost("abc"), /positive integer/);
});

test("readPost returns normalized payload", async () => {
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes("per_page=1")) return buildResponse(200, [{ id: 1 }]);
    if (u.includes("/wp-json/wp/v2/posts/12")) {
      return buildResponse(200, {
        id: 12,
        title: { rendered: "<b>T</b>" },
        status: "draft",
        slug: "t",
        date: "2026-04-14",
        modified: "2026-04-14",
        link: "https://example.com/12",
        excerpt: { rendered: "<p>short</p>" },
        content: { rendered: "<p>body</p>" },
        categories: [1],
        tags: [2]
      });
    }
    return buildResponse(404, { message: "not found" });
  };
  const client = new WordPressClient({
    baseUrl: "https://example.com",
    username: "u",
    appPassword: "p",
    preferredVersion: "v2",
    fetchImpl: mockFetch
  });
  const out = await client.readPost(12);
  assert.equal(out.post.id, 12);
  assert.equal(out.post.title, "T");
  assert.equal(out.post.content_text, "body");
});

test("createDraftFromMarkdown coerces publish to draft", async () => {
  const mockFetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes("per_page=1")) return buildResponse(200, [{ id: 1 }]);
    if (options.method === "POST") {
      const body = JSON.parse(options.body);
      return buildResponse(200, {
        id: 88,
        title: { rendered: body.title },
        status: body.status,
        link: "https://example.com/88"
      });
    }
    return buildResponse(404, { message: "not found" });
  };
  const client = new WordPressClient({
    baseUrl: "https://example.com",
    username: "u",
    appPassword: "p",
    preferredVersion: "v2",
    fetchImpl: mockFetch
  });
  const out = await client.createDraftFromMarkdown(
    "---\ntitle: Demo\nstatus: publish\n---\n\nHello"
  );
  assert.equal(out.post.status, "draft");
  assert.ok(String(out.warning).includes("changed to 'draft'"));
});

test("updateDraftFromMarkdown rejects non-draft posts", async () => {
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes("per_page=1")) return buildResponse(200, [{ id: 1 }]);
    if (u.includes("/wp-json/wp/v2/posts/77")) {
      return buildResponse(200, {
        id: 77,
        title: { rendered: "X" },
        status: "publish",
        slug: "x",
        date: "2026-04-14",
        modified: "2026-04-14",
        link: "https://example.com/77",
        excerpt: { rendered: "" },
        content: { rendered: "<p>x</p>" },
        categories: [],
        tags: []
      });
    }
    return buildResponse(404, { message: "not found" });
  };
  const client = new WordPressClient({
    baseUrl: "https://example.com",
    username: "u",
    appPassword: "p",
    preferredVersion: "v2",
    fetchImpl: mockFetch
  });
  await assert.rejects(
    () => client.updateDraftFromMarkdown(77, "---\ntitle: T\n---\n\nBody"),
    /not draft/
  );
});

test("publishPost returns updated post when confirm=true", async () => {
  const mockFetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes("per_page=1")) return buildResponse(200, [{ id: 1 }]);
    if (options.method === "POST") {
      return buildResponse(200, {
        id: 12,
        title: { rendered: "Live" },
        status: "publish",
        link: "https://example.com/live"
      });
    }
    return buildResponse(404, { message: "not found" });
  };
  const client = new WordPressClient({
    baseUrl: "https://example.com",
    username: "u",
    appPassword: "p",
    preferredVersion: "v2",
    fetchImpl: mockFetch
  });
  const out = await client.publishPost(12, true);
  assert.equal(out.post.status, "publish");
  assert.equal(out.post.id, 12);
});
