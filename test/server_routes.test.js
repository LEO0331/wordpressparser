import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

process.env.VERCEL = "1";
process.env.ADMIN_API_KEY = "secret-key";
const { default: app, handleConvertXmlRequest } = await import("../server.js");

function getRouteHandlers(appInstance, method, path) {
  const layer = appInstance._router?.stack?.find(
    (x) => x?.route?.path === path && x?.route?.methods?.[method]
  );
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  const handlers = layer.route.stack?.map((x) => x?.handle).filter(Boolean) ?? [];
  if (!handlers.length) throw new Error(`Handler not found for route ${path}`);
  return handlers;
}

async function invokeRoute(appInstance, method, path, req, res) {
  const handlers = getRouteHandlers(appInstance, method, path);
  let idx = 0;
  async function next() {
    const fn = handlers[idx++];
    if (!fn) return;
    await fn(req, res, next);
  }
  await next();
}

function createRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

const testSlug = "route-profile";
const testProfileDir = path.resolve(process.cwd(), "profiles", testSlug);

test("/api/normalize returns normalized items", async () => {
  const req = {
    body: {
      data: {
        posts: [
          {
            title: "Route Test",
            content: "<p>Hello route normalize</p>",
            date: "2026-04-14",
            URL: "https://example.com/route-test"
          }
        ]
      }
    }
  };
  const res = createRes();

  await invokeRoute(app, "post", "/api/normalize", req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.items));
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].title, "Route Test");
});

test("/api/extract-url with missing url returns 400", async () => {
  const req = { body: { platform: "auto" } };
  const res = createRes();

  await invokeRoute(app, "post", "/api/extract-url", req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Missing url");
});

test("/api/extract-url supports pixnet platform parameter", async () => {
  const oldFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith("https://emma.pixnet.cc/blog/articles")) {
      return {
        ok: false,
        status: 404,
        async text() {
          return JSON.stringify({ error: "not found" });
        }
      };
    }
    if (u.startsWith("https://emma.pixnet.cc/mainpage/blog/articles") && u.includes("page=1")) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            articles: [
              {
                title: "PIXNET Route",
                body: "<p>pixnet body</p>",
                link: "https://alice.pixnet.net/blog/post/1",
                public_at: "2026-04-14"
              }
            ]
          });
        }
      };
    }
    if (u.startsWith("https://emma.pixnet.cc/mainpage/blog/articles")) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ articles: [] });
        }
      };
    }
    return {
      ok: false,
      status: 404,
      async text() {
        return JSON.stringify({ error: "unexpected" });
      }
    };
  };

  const req = {
    body: {
      url: "https://alice.pixnet.net/blog",
      platform: "pixnet"
    }
  };
  const res = createRes();

  try {
    await invokeRoute(app, "post", "/api/extract-url", req, res);
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.body.items));
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].title, "PIXNET Route");
  } finally {
    global.fetch = oldFetch;
  }
});

test("/api/extract-url returns generic error text for invalid url", async () => {
  const req = {
    body: {
      url: "not-a-url",
      platform: "wordpress"
    }
  };
  const res = createRes();

  await invokeRoute(app, "post", "/api/extract-url", req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Failed to extract content from URL.");
});

test("/api/convert-xml returns zip and conversion report metadata", async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <item>
      <title>Route XML</title>
      <link>https://example.com/route-xml</link>
      <content:encoded><![CDATA[<p>hello <a href="https://example.com">world</a></p>]]></content:encoded>
      <wp:post_id>900</wp:post_id>
      <wp:post_date>2026-04-14 10:00:00</wp:post_date>
      <wp:post_name>route-xml</wp:post_name>
      <wp:status>publish</wp:status>
      <wp:post_type>post</wp:post_type>
    </item>
  </channel>
</rss>`;
  const boundary = "----WebKitFormBoundaryRoute";
  const body = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="export.xml"\r\n` +
    "Content-Type: text/xml\r\n\r\n" +
    xml +
    `\r\n--${boundary}--\r\n`
  );
  const req = {
    body,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`
    }
  };
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };

  handleConvertXmlRequest(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/zip");
  assert.ok(Buffer.isBuffer(res.body));
  assert.equal(res.body.subarray(0, 2).toString("utf8"), "PK");
  const report = JSON.parse(decodeURIComponent(res.headers["x-conversion-report"]));
  assert.equal(report.convertedItems, 1);
  assert.equal(report.warningCount, 0);
  assert.equal(report.firstWarning, "");
  assert.equal("warnings" in report, false);
});

test("/api/convert-xml returns 400 with invalid_xml errors", async () => {
  const boundary = "----WebKitFormBoundaryRoute";
  const body = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="broken.xml"\r\n` +
    "Content-Type: text/xml\r\n\r\n" +
    "not xml" +
    `\r\n--${boundary}--\r\n`
  );
  const req = {
    body,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`
    }
  };
  const res = createRes();
  handleConvertXmlRequest(req, res);
  assert.equal(res.statusCode, 400);
  assert.ok(String(res.body.error).includes("valid WordPress WXR XML export"));
});

test("admin-only profile mutations reject unauthenticated callers", async () => {
  const req = {
    params: { slug: "unit-profile-store" },
    body: { version: "v-2026-04-14.json" },
    get() {
      return "";
    }
  };
  const res = createRes();
  await invokeRoute(app, "post", "/api/profiles/:slug/rollback", req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "Forbidden.");
});

test("/api/health returns service status", async () => {
  const req = {};
  const res = createRes();
  await invokeRoute(app, "get", "/api/health", req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.timestamp);
});

test("GET / returns index file", async () => {
  const req = {};
  const res = {
    sentFile: "",
    sendFile(file) {
      this.sentFile = file;
    }
  };
  await invokeRoute(app, "get", "/", req, res);
  assert.ok(String(res.sentFile).endsWith("/public/index.html"));
});

test("/api/analyze validates empty items and analyzes valid payload", async () => {
  const emptyReq = { body: { items: [] } };
  const emptyRes = createRes();
  await invokeRoute(app, "post", "/api/analyze", emptyReq, emptyRes);
  assert.equal(emptyRes.statusCode, 400);

  const req = {
    body: {
      items: [
        {
          title: "A",
          content: "alpha beta gamma",
          date: "2026-04-14",
          url: "https://example.com/a",
          categories: [],
          tags: []
        }
      ],
      options: { language: "en" }
    }
  };
  const res = createRes();
  await invokeRoute(app, "post", "/api/analyze", req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.metadata.itemCount, 1);
});

test("/api/generate validates and returns markdown artifacts", async () => {
  const badReq = { body: { items: [] } };
  const badRes = createRes();
  await invokeRoute(app, "post", "/api/generate", badReq, badRes);
  assert.equal(badRes.statusCode, 400);

  const req = {
    body: {
      items: [
        {
          title: "A",
          content: "alpha beta gamma",
          date: "2026-04-14",
          url: "https://example.com/a",
          categories: [],
          tags: []
        }
      ],
      options: { language: "en", mode: "parser" }
    }
  };
  const res = createRes();
  await invokeRoute(app, "post", "/api/generate", req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(String(res.body.skillMarkdown || "").includes("## PART A"));
});

test("/api/build and /api/generate return safe 500 errors on malformed payload", async () => {
  const malformed = {
    items: [
      {
        title: "bad",
        content: null,
        date: "2026-04-14",
        url: "https://example.com/bad",
        categories: [],
        tags: []
      }
    ],
    options: { language: "en" }
  };

  const buildRes = createRes();
  await invokeRoute(app, "post", "/api/build", { body: malformed }, buildRes);
  assert.equal(buildRes.statusCode, 500);
  assert.equal(buildRes.body.error, "Failed to build profile artifacts.");

  const genRes = createRes();
  await invokeRoute(app, "post", "/api/generate", { body: malformed }, genRes);
  assert.equal(genRes.statusCode, 500);
  assert.equal(genRes.body.error, "Failed to generate artifacts.");
});

test("/api/profiles/save -> list -> read flow works", async () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  await fs.rm(testProfileDir, { recursive: true, force: true });

  const saveReq = {
    body: {
      slug: testSlug,
      name: "Route User",
      items: [
        {
          title: "A",
          content: "alpha beta gamma",
          date: "2026-04-14",
          url: "https://example.com/a",
          categories: [],
          tags: []
        }
      ],
      options: { language: "en", mode: "parser" },
      rawSource: { type: "route-test" }
    }
  };
  const saveRes = createRes();
  await invokeRoute(app, "post", "/api/profiles/save", saveReq, saveRes);
  assert.equal(saveRes.statusCode, 200);
  assert.equal(saveRes.body.storage.slug, testSlug);

  const listRes = createRes();
  await invokeRoute(app, "get", "/api/profiles", {}, listRes);
  assert.equal(listRes.statusCode, 200);
  assert.ok(Array.isArray(listRes.body.profiles));
  assert.ok(listRes.body.profiles.some((x) => x.slug === testSlug));

  const readReq = { params: { slug: testSlug } };
  const readRes = createRes();
  await invokeRoute(app, "get", "/api/profiles/:slug", readReq, readRes);
  assert.equal(readRes.statusCode, 200);
  assert.equal(readRes.body.slug, testSlug);
  assert.ok(Array.isArray(readRes.body.versions));

  await fs.rm(testProfileDir, { recursive: true, force: true });
});

test("/api/profiles/:slug returns 404 for missing profile", async () => {
  const req = { params: { slug: "missing-profile-slug" } };
  const res = createRes();
  await invokeRoute(app, "get", "/api/profiles/:slug", req, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, "Profile not found.");
});

test("/api/profiles/save validates missing items", async () => {
  const res = createRes();
  await invokeRoute(app, "post", "/api/profiles/save", { body: { items: [] } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "No items to save.");
});

test("admin update returns 400 when merged data is empty", async () => {
  const res = createRes();
  await invokeRoute(
    app,
    "post",
    "/api/profiles/:slug/update",
    {
      params: { slug: "non-existent" },
      body: { items: [] },
      get(name) {
        if (name === "x-admin-key") return "secret-key";
        return "";
      }
    },
    res
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "No profile data to update.");
});

test("admin update/correct/rollback surface safe 500 messages on missing profile/invalid version", async () => {
  const authReqBase = {
    get(name) {
      if (name === "x-admin-key") return "secret-key";
      return "";
    }
  };

  const updateRes = createRes();
  await invokeRoute(
    app,
    "post",
    "/api/profiles/:slug/update",
    {
      ...authReqBase,
      params: { slug: "missing-slug" },
      body: {
        items: [{ title: "x", content: "y", date: "2026-01-01", url: "u", categories: [], tags: [] }]
      }
    },
    updateRes
  );
  assert.equal(updateRes.statusCode, 500);
  assert.equal(updateRes.body.error, "Failed to update profile.");

  const correctRes = createRes();
  await invokeRoute(
    app,
    "post",
    "/api/profiles/:slug/correct",
    {
      ...authReqBase,
      params: { slug: "missing-slug" },
      body: { scope: "persona", correction: "fix this" }
    },
    correctRes
  );
  assert.equal(correctRes.statusCode, 500);
  assert.equal(correctRes.body.error, "Failed to apply correction.");

  const rollbackRes = createRes();
  await invokeRoute(
    app,
    "post",
    "/api/profiles/:slug/rollback",
    {
      ...authReqBase,
      params: { slug: "missing-slug" },
      body: { version: "bad/../v.json" }
    },
    rollbackRes
  );
  assert.equal(rollbackRes.statusCode, 500);
  assert.equal(rollbackRes.body.error, "Failed to rollback profile.");
});

test("admin protected update/correct/rollback works with key", async () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  await fs.rm(testProfileDir, { recursive: true, force: true });

  const seedItems = [
    {
      title: "Seed",
      content: "seed content",
      date: "2026-04-14",
      url: "https://example.com/seed",
      categories: [],
      tags: []
    }
  ];
  const saveRes = createRes();
  await invokeRoute(
    app,
    "post",
    "/api/profiles/save",
    {
      body: {
        slug: testSlug,
        name: "Route User",
        items: seedItems,
        options: { language: "en", mode: "parser" }
      }
    },
    saveRes
  );
  assert.equal(saveRes.statusCode, 200);

  const adminHeadersReq = {
    params: { slug: testSlug },
    body: {
      items: [
        {
          title: "Update",
          content: "update content",
          date: "2026-04-15",
          url: "https://example.com/update",
          categories: [],
          tags: []
        }
      ],
      options: { language: "en", mode: "parser" }
    },
    get(name) {
      if (name === "x-admin-key") return "secret-key";
      return "";
    }
  };
  const updateRes = createRes();
  await invokeRoute(app, "post", "/api/profiles/:slug/update", adminHeadersReq, updateRes);
  assert.equal(updateRes.statusCode, 200);

  const correctRes = createRes();
  await invokeRoute(
    app,
    "post",
    "/api/profiles/:slug/correct",
    {
      params: { slug: testSlug },
      body: { scope: "persona", correction: "be concise" },
      get(name) {
        if (name === "authorization") return "Bearer secret-key";
        return "";
      }
    },
    correctRes
  );
  assert.equal(correctRes.statusCode, 200);

  const readRes = createRes();
  await invokeRoute(app, "get", "/api/profiles/:slug", { params: { slug: testSlug } }, readRes);
  const version = readRes.body.versions[0];
  assert.ok(version);

  const rollbackRes = createRes();
  await invokeRoute(
    app,
    "post",
    "/api/profiles/:slug/rollback",
    {
      params: { slug: testSlug },
      body: { version },
      get(name) {
        if (name === "x-admin-key") return "secret-key";
        return "";
      }
    },
    rollbackRes
  );
  assert.equal(rollbackRes.statusCode, 200);
  assert.equal(rollbackRes.body.restored, true);

  await fs.rm(testProfileDir, { recursive: true, force: true });
});
