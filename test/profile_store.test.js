import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  applyProfileCorrection,
  listProfileVersions,
  readNormalizedItems,
  readProfile,
  rollbackProfileStore,
  saveProfile,
  toSlug
} from "../src/profile_store.js";

const slug = "unit-profile-store";
const profileDir = path.resolve(process.cwd(), "profiles", slug);

async function cleanup() {
  await fs.rm(profileDir, { recursive: true, force: true });
}

test("toSlug normalizes input safely", () => {
  assert.equal(toSlug(" Leo Li Cheng "), "leo-li-cheng");
  assert.equal(toSlug(""), "author");
});

test("save/read/update/correct/rollback lifecycle works on filesystem backend", async () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  await cleanup();

  const payload = {
    slug,
    meta: {
      name: "Unit Test",
      slug,
      language: "en",
      updated_at: new Date().toISOString(),
      mode: "parser",
      source_count: 1,
      knowledge_topics: ["topic-a"],
      tags: { tone: ["concise"] }
    },
    knowledgeMarkdown: "base knowledge",
    personaMarkdown: "base persona",
    skillMarkdown: "base skill",
    rag: [{ id: "c1", text: "chunk", metadata: {} }],
    knowledgeAnalysis: { core_topics: ["topic-a"] },
    personaAnalysis: { voice: { tone: "concise" } },
    rawSource: { source: "test" },
    normalizedItems: [{ title: "t", content: "c", date: "2026-01-01", url: "u" }]
  };

  const first = await saveProfile(payload);
  assert.equal(first.slug, slug);
  assert.equal(first.storage, "filesystem");

  const read1 = await readProfile(slug);
  assert.equal(read1.meta.name, "Unit Test");
  assert.equal(read1.knowledgeMarkdown, "base knowledge");

  const second = await saveProfile({
    ...payload,
    knowledgeMarkdown: "updated knowledge",
    meta: { ...payload.meta, updated_at: new Date().toISOString() }
  });
  assert.equal(second.alreadyExists, true);

  const versions = await listProfileVersions(slug);
  assert.ok(versions.length >= 1);

  const normalized = await readNormalizedItems(slug);
  assert.equal(normalized.length, 1);

  const corrected = await applyProfileCorrection(slug, "persona", "be more direct");
  assert.equal(corrected.scope, "persona");
  assert.ok(corrected.corrections_count >= 1);

  const versionsAfterCorrection = await listProfileVersions(slug);
  assert.ok(versionsAfterCorrection.length >= versions.length);

  const rollbackResult = await rollbackProfileStore(slug, versionsAfterCorrection[0]);
  assert.equal(rollbackResult.restored, true);

  await cleanup();
});
