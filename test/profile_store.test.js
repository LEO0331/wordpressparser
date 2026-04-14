import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  applyProfileCorrection,
  backupProfileStore,
  listProfiles,
  listProfileVersions,
  profileRoot,
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
  assert.ok(profileRoot().endsWith("profiles"));
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
    wikiMarkdown: "# Wiki Index\n\n## Overview\n- Name: Unit Test",
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

test("readProfile falls back to legacy rag.json when wiki.md is missing", async () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  await cleanup();

  const legacyDir = path.resolve(process.cwd(), "profiles", slug);
  await fs.mkdir(path.join(legacyDir, "analysis"), { recursive: true });
  await fs.mkdir(path.join(legacyDir, "raw"), { recursive: true });
  await fs.writeFile(
    path.join(legacyDir, "meta.json"),
    JSON.stringify({ name: "Legacy", slug, language: "en" }, null, 2),
    "utf8"
  );
  await fs.writeFile(path.join(legacyDir, "knowledge.md"), "legacy knowledge", "utf8");
  await fs.writeFile(path.join(legacyDir, "persona.md"), "legacy persona", "utf8");
  await fs.writeFile(path.join(legacyDir, "skill.md"), "legacy skill", "utf8");
  await fs.writeFile(
    path.join(legacyDir, "rag.json"),
    JSON.stringify([{ id: "c1", text: "legacy chunk", metadata: { title: "T1" } }], null, 2),
    "utf8"
  );

  const read = await readProfile(slug);
  assert.ok(read.wikiMarkdown.includes("Legacy RAG Snapshot"));
  assert.ok(read.wikiMarkdown.includes("legacy chunk"));

  await cleanup();
});

test("rollbackProfileStore rejects unsafe version values", async () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  await cleanup();

  await assert.rejects(
    () => rollbackProfileStore(slug, "../outside.json"),
    /Invalid version identifier/
  );
});

test("listProfiles and listProfileVersions handle missing dirs", async () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  await cleanup();
  const versions = await listProfileVersions(slug);
  assert.deepEqual(versions, []);
  const profiles = await listProfiles();
  assert.ok(Array.isArray(profiles));
});

test("backupProfileStore creates version file and invalid snapshot is rejected", async () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  await cleanup();

  await saveProfile({
    slug,
    meta: { name: "Backup", slug, language: "en", updated_at: new Date().toISOString() },
    knowledgeMarkdown: "k",
    personaMarkdown: "p",
    skillMarkdown: "s",
    wikiMarkdown: "w",
    knowledgeAnalysis: {},
    personaAnalysis: {},
    normalizedItems: [{ title: "x", content: "y", date: "2026-04-01", url: "u" }]
  });

  const version = await backupProfileStore(slug);
  assert.ok(version.endsWith(".json"));

  const badVersion = "bad-snapshot.json";
  await fs.writeFile(
    path.join(profileDir, "versions", badVersion),
    JSON.stringify({ nope: true }, null, 2),
    "utf8"
  );
  await assert.rejects(() => rollbackProfileStore(slug, badVersion), /Invalid snapshot/);

  await cleanup();
});

test("applyProfileCorrection supports knowledge scope", async () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  await cleanup();

  await saveProfile({
    slug,
    meta: {
      name: "Knowledge User",
      slug,
      language: "en",
      updated_at: new Date().toISOString(),
      knowledge_topics: ["topic"]
    },
    knowledgeMarkdown: "knowledge",
    personaMarkdown: "persona",
    skillMarkdown: "skill",
    wikiMarkdown: "wiki",
    knowledgeAnalysis: {},
    personaAnalysis: {},
    normalizedItems: [{ title: "x", content: "y", date: "2026-04-01", url: "u" }]
  });

  const out = await applyProfileCorrection(slug, "knowledge", "add stronger evidence");
  assert.equal(out.scope, "knowledge");
  const read = await readProfile(slug);
  assert.ok(read.knowledgeMarkdown.includes("Correction Log"));

  await cleanup();
});
