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
  readProfile,
  rollbackProfileStore,
  saveProfile,
  setBlobDepsForTest,
  toVersionId,
  writeBlob
} from "../src/profile_store.js";

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
  await writeBlob("profiles/a/meta.json", "hello", async (pathname, content, options) => {
    puts.push({ pathname, content, options });
    return {};
  });
  assert.equal(puts.length, 1);
  assert.equal(puts[0].pathname, "profiles/a/meta.json");

  const listed = await listBlobPrefix(
    "profiles/",
    async () => ({ blobs: [{ pathname: "profiles/a/meta.json", url: "https://x.test/1" }] })
  );
  assert.equal(listed.length, 1);

  const content = await readBlob(
    "profiles/a/meta.json",
    async () => ({ blobs: [{ pathname: "profiles/a/meta.json", url: "https://x.test/1" }] }),
    async () => ({ ok: true, async text() { return "{\"ok\":true}"; } })
  );
  assert.equal(content, "{\"ok\":true}");

  await assert.rejects(
    () =>
      readBlob(
        "profiles/missing/meta.json",
        async () => ({ blobs: [] }),
        async () => ({ ok: true, async text() { return ""; } })
      ),
    /Blob not found/
  );
});

test("blob-mode profile store lifecycle works with injected blob adapters", async () => {
  const oldToken = process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  const store = new Map();

  function toBlobUrl(pathname) {
    return `blob:///${encodeURIComponent(pathname)}`;
  }
  function fromBlobUrl(url) {
    return decodeURIComponent(String(url).replace("blob:///", ""));
  }

  setBlobDepsForTest({
    putImpl: async (pathname, content) => {
      store.set(pathname, String(content));
      return {};
    },
    listImpl: async ({ prefix }) => {
      const blobs = [...store.keys()]
        .filter((x) => x.startsWith(prefix))
        .map((pathname) => ({ pathname, url: toBlobUrl(pathname) }));
      return { blobs };
    },
    fetchImpl: async (url) => {
      const pathname = fromBlobUrl(url);
      if (!store.has(pathname)) {
        return { ok: false, async text() { return ""; } };
      }
      return {
        ok: true,
        async text() {
          return store.get(pathname);
        }
      };
    }
  });

  try {
    const slug = "blob-user";
    await saveProfile({
      slug,
      meta: {
        name: "Blob User",
        slug,
        language: "en",
        updated_at: new Date().toISOString(),
        knowledge_topics: ["x"]
      },
      knowledgeMarkdown: "k",
      personaMarkdown: "p",
      skillMarkdown: "s",
      wikiMarkdown: "w",
      knowledgeAnalysis: {},
      personaAnalysis: {},
      normalizedItems: [{ title: "t", content: "c", date: "2026-01-01", url: "u" }]
    });

    const read = await readProfile(slug);
    assert.equal(read.slug, slug);

    const profiles = await listProfiles();
    assert.ok(profiles.some((x) => x.slug === slug));

    const versionId = await backupProfileStore(slug);
    assert.ok(versionId.endsWith(".json"));

    const versions = await listProfileVersions(slug);
    assert.ok(versions.length >= 1);

    const rolled = await rollbackProfileStore(slug, versions[0]);
    assert.equal(rolled.restored, true);
  } finally {
    setBlobDepsForTest(null);
    if (oldToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = oldToken;
  }
});

test("blob-mode readProfile falls back to legacy rag when wiki missing", async () => {
  const oldToken = process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  const store = new Map();

  function toBlobUrl(pathname) {
    return `blob:///${encodeURIComponent(pathname)}`;
  }
  function fromBlobUrl(url) {
    return decodeURIComponent(String(url).replace("blob:///", ""));
  }

  setBlobDepsForTest({
    putImpl: async (pathname, content) => {
      store.set(pathname, String(content));
      return {};
    },
    listImpl: async ({ prefix }) => {
      const blobs = [...store.keys()]
        .filter((x) => x.startsWith(prefix))
        .map((pathname) => ({ pathname, url: toBlobUrl(pathname) }));
      return { blobs };
    },
    fetchImpl: async (url) => {
      const pathname = fromBlobUrl(url);
      if (!store.has(pathname)) {
        return { ok: false, async text() { return ""; } };
      }
      return {
        ok: true,
        async text() {
          return store.get(pathname);
        }
      };
    }
  });

  try {
    const slug = "blob-legacy";
    store.set(`profiles/${slug}/meta.json`, JSON.stringify({ name: "Legacy", slug }, null, 2));
    store.set(`profiles/${slug}/knowledge.md`, "k");
    store.set(`profiles/${slug}/persona.md`, "p");
    store.set(`profiles/${slug}/skill.md`, "s");
    store.set(
      `profiles/${slug}/rag.json`,
      JSON.stringify([{ text: "legacy", metadata: { title: "T" } }], null, 2)
    );
    const read = await readProfile(slug);
    assert.ok(read.wikiMarkdown.includes("Legacy RAG Snapshot"));
  } finally {
    setBlobDepsForTest(null);
    if (oldToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = oldToken;
  }
});
