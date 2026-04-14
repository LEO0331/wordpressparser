import test from "node:test";
import assert from "node:assert/strict";

process.env.VERCEL = "1";
const { default: app } = await import("../server.js");

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
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, "Admin actions are not configured.");
});
