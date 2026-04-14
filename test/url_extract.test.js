import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeExtractionTarget,
  detectPlatformByUrl,
  fetchByUrl,
  fetchPixnetByUrl,
  fetchWordPressByUrl,
  parsePixnetIdentity
} from "../src/url_extract.js";

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    }
  };
}

test("detectPlatformByUrl auto-detects pixnet by host", () => {
  assert.equal(detectPlatformByUrl("https://myblog.pixnet.net/blog"), "pixnet");
  assert.equal(detectPlatformByUrl("https://example.wordpress.com/"), "wordpress");
  assert.equal(detectPlatformByUrl("https://myblog.pixnet.net/blog", "wordpress"), "wordpress");
});

test("parsePixnetIdentity extracts user from subdomain and query", () => {
  assert.equal(parsePixnetIdentity("https://alice.pixnet.net/blog/post/1"), "alice");
  assert.equal(
    parsePixnetIdentity("https://www.pixnet.net/blog?user=bob"),
    "bob"
  );
});

test("parsePixnetIdentity rejects ambiguous reserved pixnet.net path", () => {
  assert.throws(
    () => parsePixnetIdentity("https://pixnet.net/blog"),
    /Cannot infer PIXNET user/
  );
});

test("fetchPixnetByUrl falls back endpoint and normalizes items", async () => {
  const calls = [];
  const mockFetch = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith("https://emma.pixnet.cc/blog/articles")) {
      return jsonResponse(404, { error: "not found" });
    }
    if (String(url).includes("page=1")) {
      return jsonResponse(200, {
        articles: [
          {
            title: "PIXNET Post",
            body: "<p>Hello PIXNET</p>",
            link: "https://alice.pixnet.net/blog/post/1",
            public_at: "2026-04-14",
            tags: [{ tag: "travel" }]
          }
        ]
      });
    }
    return jsonResponse(200, { articles: [] });
  };

  const items = await fetchPixnetByUrl("https://alice.pixnet.net/blog", mockFetch);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "PIXNET Post");
  assert.ok(items[0].content.includes("Hello PIXNET"));
  assert.ok(calls.some((x) => x.startsWith("https://emma.pixnet.cc/blog/articles")));
  assert.ok(calls.some((x) => x.startsWith("https://emma.pixnet.cc/mainpage/blog/articles")));
});

test("fetchByUrl auto uses pixnet flow", async () => {
  const mockFetch = async (url) => {
    if (String(url).startsWith("https://emma.pixnet.cc/blog/articles")) {
      return jsonResponse(404, {});
    }
    if (String(url).includes("page=1")) {
      return jsonResponse(200, {
        articles: [
          {
            title: "Post 1",
            body: "<p>body</p>",
            link: "https://me.pixnet.net/blog/post/1",
            public_at: "2026-04-14"
          }
        ]
      });
    }
    return jsonResponse(200, { articles: [] });
  };

  const items = await fetchByUrl("https://me.pixnet.net/blog", "auto", mockFetch);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Post 1");
});

test("fetchWordPressByUrl keeps wordpress path behavior", async () => {
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes("/wp-json/wp/v2/posts")) {
      if (u.includes("page=1")) {
        return jsonResponse(200, [
          {
            title: { rendered: "WP One" },
            content: { rendered: "<p>wp content</p>" },
            date: "2026-04-12",
            link: "https://example.com/wp-one",
            categories: [],
            tags: []
          }
        ]);
      }
      return jsonResponse(200, []);
    }
    if (u.includes("/wp-json/wp/v2/pages")) {
      return jsonResponse(200, []);
    }
    return jsonResponse(404, {});
  };

  const mockResolver = async () => [{ address: "93.184.216.34" }];
  const items = await fetchWordPressByUrl("https://example.com/", mockFetch, mockResolver);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "WP One");
});

test("fetchPixnetByUrl raises actionable error if endpoints fail", async () => {
  const mockFetch = async () => jsonResponse(404, {});
  await assert.rejects(
    () => fetchPixnetByUrl("https://charlie.pixnet.net/blog", mockFetch),
    /Unable to fetch PIXNET data from URL/
  );
});

test("assertSafeExtractionTarget blocks localhost and private network addresses", async () => {
  await assert.rejects(
    () => assertSafeExtractionTarget("https://localhost/blog"),
    /Target host is not allowed/
  );

  const privateResolver = async () => [{ address: "10.0.0.7" }];
  await assert.rejects(
    () => assertSafeExtractionTarget("https://example.com/blog", privateResolver),
    /private or local network/
  );
});
