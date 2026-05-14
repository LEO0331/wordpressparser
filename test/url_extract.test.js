import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeExtractionTarget,
  detectPlatformByUrl,
  fetchWpComItems,
  fetchWpRestItems,
  fetchByUrl,
  fetchPixnetByUrl,
  fetchWordPressByUrl,
  sanitizeSiteUrl,
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

test("sanitizeSiteUrl rejects unsupported protocols", () => {
  assert.throws(() => sanitizeSiteUrl("ftp://example.com"), /Only http\/https/);
});

test("sanitizeSiteUrl preserves baseUrl but separates hostname from port", () => {
  const result = sanitizeSiteUrl("https://example.com:8443/blog");
  assert.equal(result.baseUrl, "https://example.com:8443");
  assert.equal(result.host, "example.com:8443");
  assert.equal(result.hostname, "example.com");
});

test("assertSafeExtractionTarget allows public literal IP", async () => {
  await assert.doesNotReject(() => assertSafeExtractionTarget("https://8.8.8.8/blog"));
});

test("assertSafeExtractionTarget resolves hostname without port suffix", async () => {
  let resolvedHost = "";
  const resolver = async (host) => {
    resolvedHost = host;
    return [{ address: "93.184.216.34" }];
  };
  await assert.doesNotReject(() => assertSafeExtractionTarget("https://example.com:8443/blog", resolver));
  assert.equal(resolvedHost, "example.com");
});

test("fetchWpRestItems breaks on 404 and throws on non-404 errors", async () => {
  const notFound = async () => jsonResponse(404, {});
  const rows = await fetchWpRestItems("https://example.com", "posts", notFound);
  assert.equal(rows.length, 0);

  const fail = async () => jsonResponse(500, {});
  await assert.rejects(
    () => fetchWpRestItems("https://example.com", "posts", fail),
    /posts request failed with 500/
  );
});

test("fetchWpComItems handles pages and request errors", async () => {
  const okFetch = async (url) => {
    const u = String(url);
    if (u.includes("page=1")) {
      return jsonResponse(200, { posts: [{ id: 1 }, { id: 2 }] });
    }
    return jsonResponse(200, { posts: [] });
  };
  const rows = await fetchWpComItems("example.com", "page", okFetch);
  assert.equal(rows.length, 2);

  const failFetch = async () => jsonResponse(500, {});
  await assert.rejects(() => fetchWpComItems("example.com", "post", failFetch), /WordPress.com API/);
});

test("fetchWordPressByUrl throws when wp v2 and wp.com both empty with wp error", async () => {
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes("/wp-json/wp/v2/")) return jsonResponse(500, {});
    return jsonResponse(404, {});
  };
  const resolver = async () => [{ address: "93.184.216.34" }];
  await assert.rejects(
    () => fetchWordPressByUrl("https://example.com", mockFetch, resolver),
    /Unable to fetch WordPress data from URL/
  );
});

test("detectPlatformByUrl and parsePixnetIdentity ignore port suffixes", () => {
  assert.equal(detectPlatformByUrl("https://alice.pixnet.net:8080/blog"), "pixnet");
  assert.equal(parsePixnetIdentity("https://alice.pixnet.net:8080/blog/post/1"), "alice");
});

test("parsePixnetIdentity handles host pixnet.net with user path", () => {
  assert.equal(parsePixnetIdentity("https://pixnet.net/alice"), "alice");
  assert.throws(
    () => parsePixnetIdentity("https://www.pixnet.net/blog"),
    /Cannot infer PIXNET user/
  );
});

test("fetchPixnetByUrl surfaces non-json payload errors", async () => {
  const mockFetch = async (url) => {
    if (String(url).startsWith("https://emma.pixnet.cc/blog/articles")) {
      return {
        ok: true,
        status: 200,
        async text() {
          return "<html>oops</html>";
        }
      };
    }
    return jsonResponse(404, {});
  };
  await assert.rejects(
    () => fetchPixnetByUrl("https://alice.pixnet.net/blog", mockFetch),
    /Unable to fetch PIXNET data from URL/
  );
});
