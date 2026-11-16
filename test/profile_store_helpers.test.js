import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeVersionFilename,
  backupProfileStore,
  isBlobNotFoundError,
  json,
  legacyRagToWikiMarkdown,
  listProfileVersions,
  listProfiles,
  listBlobPrefix,
  parseJson,
  readBlob,
  readIdempotencyRecord,
  readNormalizedItems,
  readProfile,
  rollbackProfileStore,
  saveProfile,
  setBlobDepsForTest,
  toVersionId,
  writeBlob,
  writeIdempotencyRecord
} from "../src/profile_store.js";

function useMockBlob(t) {
  const oldToken = process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  const store = new Map();
  const deps = {
    putImpl: async (pathname, content, options) => {
      assert.equal(options.access, "private");
      assert.equal(options.token, "test-token");
      if (store.has(pathname) && !options.allowOverwrite) throw new Error("Blob already exists");
      store.set(pathname, String(content));
    },
    getImpl: async (pathname, options) => {
      assert.equal(options.access, "private");
      assert.equal(options.token, "test-token");
      return store.has(pathname) ? { statusCode: 200, stream: new Response(store.get(pathname)).body } : null;
    },
    listImpl: async ({ prefix, token }) => {
      assert.equal(token, "test-token");
      const blobs = [...store.keys()].filter((x) => x.startsWith(prefix)).map((pathname) => ({ pathname }));
      return { blobs };
    },
    deleteImpl: async (pathnames, { token }) => {
      assert.equal(token, "test-token");
      for (const pathname of pathnames) store.delete(pathname);
    }
  };
  setBlobDepsForTest(deps);
  t.after(() => {
    setBlobDepsForTest(null);
    if (oldToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = oldToken;
  });
  return { store, deps };
}

function blobPayload(slug) {
  return {
    slug,
    meta: { name: "Blob User", slug, language: "en", updated_at: "2026-01-01", knowledge_topics: ["x"] },
    knowledgeMarkdown: "k",
    personaMarkdown: "p",
    skillMarkdown: "s",
    wikiMarkdown: "w",
    knowledgeAnalysis: {},
    personaAnalysis: {},
    normalizedItems: [{ title: "t" }],
    rawSource: { source: "original" }
  };
}

test("profile_store helper functions cover parsing and formatting", () => {
  assert.equal(parseJson("{\"a\":1}", {}).a, 1);
  assert.deepEqual(parseJson("{", { ok: false }), { ok: false });
  assert.equal(json({ a: 1 }).includes("\"a\""), true);
  const wiki = legacyRagToWikiMarkdown([{ text: "chunk", metadata: { title: "T", date: "D", url: "U" } }], "s");
  assert.ok(wiki.includes("Legacy RAG Snapshot"));
  assert.ok(toVersionId().startsWith("v-"));
  assert.equal(isBlobNotFoundError(new Error("Blob not found: x")), true);
  assert.equal(isBlobNotFoundError(new Error("another")), false);
  assert.equal(assertSafeVersionFilename("v-1.json"), "v-1.json");
  assert.throws(() => assertSafeVersionFilename("../bad"), /Invalid version identifier/);
});

test("writeBlob/readBlob/listBlobPrefix support injected implementations", async () => {
  const puts = [];
  await writeBlob("profiles/a/meta.json", "hello", {
    putImpl: async (pathname, content, options) => {
      puts.push({ pathname, content, options });
    }
  });
  assert.equal(puts.length, 1);
  assert.equal(puts[0].pathname, "profiles/a/meta.json");
  assert.equal(puts[0].options.access, "private");
  assert.equal(puts[0].options.allowOverwrite, false);

  const listed = await listBlobPrefix(
    "profiles/",
    async () => ({ blobs: [{ pathname: "profiles/a/meta.json", url: "https://x.test/1" }] })
  );
  assert.equal(listed.length, 1);

  const content = await readBlob(
    "profiles/a/meta.json",
    async (pathname, options) => {
      assert.equal(pathname, "profiles/a/meta.json");
      assert.equal(options.access, "private");
      assert.equal(options.useCache, false);
      return { statusCode: 200, stream: new Response('{"ok":true}').body };
    }
  );
  assert.equal(content, "{\"ok\":true}");

  await assert.rejects(
    () => readBlob("profiles/missing/meta.json", async () => null),
    /Blob not found/
  );
});

test("private Blob profile lifecycle preserves store data through updates and rollback", async (t) => {
  const { store } = useMockBlob(t);
  const slug = "blob-user";
  const payload = blobPayload(slug);
  await saveProfile(payload, { createOnly: true });
  assert.equal((await readProfile(slug)).slug, slug);
  assert.deepEqual(await readNormalizedItems(slug), payload.normalizedItems);
  assert.ok((await listProfiles()).some((profile) => profile.name === "Blob User"));

  const versionId = await backupProfileStore(slug);
  assert.deepEqual(await listProfileVersions(slug), [versionId]);
  await saveProfile({ ...payload, knowledgeMarkdown: "new", rawSource: undefined });
  assert.equal((await readProfile(slug)).knowledgeMarkdown, "new");
  assert.equal((await rollbackProfileStore(slug, versionId)).restored, true);
  assert.equal((await readProfile(slug)).knowledgeMarkdown, "k");
  assert.equal([...store.entries()].find(([pathname]) => pathname.endsWith("raw/source.json"))[1], json(payload.rawSource));

  await writeIdempotencyRecord("cache-key", { response: "old" });
  await writeIdempotencyRecord("cache-key", { response: "new" });
  assert.deepEqual(await readIdempotencyRecord("cache-key"), { response: "new" });
});

test("private Blob reads migrated profile files and falls back to legacy RAG", async (t) => {
  const { store } = useMockBlob(t);
  const slug = "blob-legacy";
  store.set(`profiles/${slug}/meta.json`, json({ name: "Legacy", slug }));
  store.set(`profiles/${slug}/knowledge.md`, "k");
  store.set(`profiles/${slug}/persona.md`, "p");
  store.set(`profiles/${slug}/skill.md`, "s");
  store.set(`profiles/${slug}/rag.json`, json([{ text: "legacy", metadata: { title: "T" } }]));
  assert.ok((await readProfile(slug)).wikiMarkdown.includes("Legacy RAG Snapshot"));
  await assert.rejects(saveProfile(blobPayload(slug), { createOnly: true }), { code: "profile_already_exists" });
});

test("only one concurrent Blob create publishes artifacts for a slug", async (t) => {
  const { store } = useMockBlob(t);
  const slug = "blob-race";
  const payload = blobPayload(slug);
  const results = await Promise.allSettled([
    saveProfile(payload, { createOnly: true }),
    saveProfile({ ...payload, knowledgeMarkdown: "other" }, { createOnly: true })
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.code, "profile_already_exists");
  const read = await readProfile(slug);
  assert.equal(read.knowledgeMarkdown, results[0].status === "fulfilled" ? "k" : "other");
  assert.equal(store.size, 9);
  assert.deepEqual(await listProfileVersions(slug), []);
});

test("failed Blob create leaves the slug available to retry", async (t) => {
  const { store, deps } = useMockBlob(t);
  const payload = blobPayload("blob-retry");
  setBlobDepsForTest({
    ...deps,
    putImpl: async (pathname, content, options) => {
      if (pathname.endsWith("/skill.md")) throw new Error("Temporary upload failure");
      return deps.putImpl(pathname, content, options);
    }
  });
  await assert.rejects(saveProfile(payload, { createOnly: true }), /Temporary upload failure/);
  assert.equal(store.size, 0);
  assert.deepEqual(await listProfiles(), []);

  setBlobDepsForTest(deps);
  await saveProfile(payload, { createOnly: true });
  assert.equal((await readProfile(payload.slug)).skillMarkdown, "s");
});
