import assert from "node:assert/strict";
import test from "node:test";
import { BlobPreconditionFailedError } from "@vercel/blob";
import { takeAiQuota } from "../src/ai_quota.js";

test("Vercel AI quota requires shared storage", async () => {
  await assert.rejects(takeAiQuota({ token: "", distributed: true }), /private Blob store/);
});

test("shared quota reads private origin data and retries a conflicting write", async () => {
  const dateNow = Date.now;
  Date.now = () => 90_000;
  try {
    let reads = 0;
    let writes = 0;
    const retryAfter = await takeAiQuota({
      token: "test-token",
      getBlob: async (_path, options) => {
        assert.equal(options.access, "private");
        assert.equal(options.useCache, false);
        reads += 1;
        return {
          blob: { etag: `revision-${reads}` },
          stream: new Response(JSON.stringify({
            minute: 1, day: 0, minuteCount: 10 + reads, dayCount: 10 + reads
          })).body
        };
      },
      putBlob: async (_path, _body, options) => {
        writes += 1;
        assert.equal(options.ifMatch, "revision-1");
        throw new BlobPreconditionFailedError();
      }
    });
    assert.equal(reads, 2);
    assert.equal(writes, 1);
    assert.equal(retryAfter, 30);
  } finally {
    Date.now = dateNow;
  }
});
