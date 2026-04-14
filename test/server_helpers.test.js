import test from "node:test";
import assert from "node:assert/strict";
process.env.VERCEL = "1";
const {
  logServerError,
  readAdminKey,
  requireAdminForMutation,
  sendSafeError
} = await import("../server.js");

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

test("readAdminKey reads x-admin-key then bearer fallback", () => {
  const req1 = {
    get(name) {
      if (name === "x-admin-key") return "abc";
      return "";
    }
  };
  assert.equal(readAdminKey(req1), "abc");

  const req2 = {
    get(name) {
      if (name === "authorization") return "Bearer xyz";
      return "";
    }
  };
  assert.equal(readAdminKey(req2), "xyz");
});

test("sendSafeError writes status and body", () => {
  const res = createRes();
  sendSafeError(res, { status: 418, message: "tea", context: "ctx" });
  assert.equal(res.statusCode, 418);
  assert.equal(res.body.error, "tea");
});

test("logServerError calls console.error", () => {
  const old = console.error;
  let called = false;
  console.error = () => {
    called = true;
  };
  try {
    logServerError("ctx", new Error("x"));
    assert.equal(called, true);
  } finally {
    console.error = old;
  }
});

test("requireAdminForMutation handles no-key, forbidden, and success", async () => {
  const req = {
    get(name) {
      if (name === "x-admin-key") return "wrong";
      return "";
    }
  };
  const resNoKey = createRes();
  await requireAdminForMutation(req, resNoKey, () => {}, "");
  assert.equal(resNoKey.statusCode, 503);

  const resForbidden = createRes();
  await requireAdminForMutation(req, resForbidden, () => {}, "expected");
  assert.equal(resForbidden.statusCode, 403);

  let nextCalled = false;
  const reqOk = {
    get(name) {
      if (name === "x-admin-key") return "expected";
      return "";
    }
  };
  const resOk = createRes();
  await requireAdminForMutation(reqOk, resOk, () => {
    nextCalled = true;
  }, "expected");
  assert.equal(nextCalled, true);
});
