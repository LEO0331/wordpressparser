import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { del, get, list, put } from "@vercel/blob";
import { buildSkillMarkdown } from "./skill_template.js";

const PROFILE_ROOT = path.resolve(process.cwd(), "profiles");
const defaultBlobDeps = {
  putImpl: put,
  getImpl: get,
  listImpl: list,
  deleteImpl: del
};
let blobDeps = defaultBlobDeps;

export function setBlobDepsForTest(overrides = null) {
  blobDeps = overrides ? { ...defaultBlobDeps, ...overrides } : defaultBlobDeps;
}

function blobEnabled() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN;
}

export function json(value) {
  return JSON.stringify(value, null, 2);
}

export function parseJson(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function legacyRagToWikiMarkdown(rag, slug) {
  const rows = Array.isArray(rag) ? rag : [];
  const body = rows
    .slice(0, 100)
    .map((item) => {
      const title = item?.metadata?.title || "Untitled";
      const date = item?.metadata?.date || "unknown";
      const url = item?.metadata?.url || "";
      const text = String(item?.text || "").trim();
      return `### ${title}\n- Date: ${date}\n- URL: ${url}\n\n${text}`;
    })
    .join("\n\n");
  return `# Wiki Index\n\n## Legacy RAG Snapshot\n\nProfile: ${slug}\n\n${body || "No legacy chunks available."}\n`;
}

export function toVersionId() {
  return `v-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(target) {
  if (!(await exists(target))) return null;
  return fs.readFile(target, "utf8");
}

export function profileRoot() {
  return PROFILE_ROOT;
}

export function toSlug(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "author";
}

export async function writeBlob(pathname, content, { putImpl = blobDeps.putImpl, allowOverwrite = false } = {}) {
  await putImpl(pathname, content, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite,
    token: blobToken()
  });
}

export async function readBlob(pathname, getImpl = blobDeps.getImpl) {
  const result = await getImpl(pathname, {
    access: "private",
    useCache: false,
    token: blobToken()
  });
  if (!result) throw new Error(`Blob not found: ${pathname}`);
  if (result.statusCode !== 200 || !result.stream) throw new Error(`Failed to fetch blob: ${pathname}`);
  return new Response(result.stream).text();
}

export function isBlobNotFoundError(error) {
  const message = String(error?.message || "");
  return message.startsWith("Blob not found:");
}

export async function listBlobPrefix(prefix, listImpl = blobDeps.listImpl) {
  const result = await listImpl({
    prefix,
    token: blobToken()
  });
  return result.blobs ?? [];
}

function idempotencyPath(recordKey) {
  return `idempotency/${recordKey}.json`;
}

function idempotencyLocalPath(recordKey) {
  return path.join(PROFILE_ROOT, ".idempotency", `${recordKey}.json`);
}

export async function readIdempotencyRecord(recordKey) {
  if (blobEnabled()) {
    const raw = await readBlob(idempotencyPath(recordKey));
    return parseJson(raw, null);
  }

  const raw = await fs.readFile(idempotencyLocalPath(recordKey), "utf8");
  return parseJson(raw, null);
}

export async function writeIdempotencyRecord(recordKey, payload) {
  if (blobEnabled()) {
    await writeBlob(idempotencyPath(recordKey), json(payload), { allowOverwrite: true });
    return;
  }

  const target = idempotencyLocalPath(recordKey);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, json(payload), "utf8");
}

function profilePath(slug, file) {
  return `profiles/${slug}/${file}`;
}

export function assertSafeVersionFilename(versionInput) {
  const version = String(versionInput || "").trim();
  if (!/^[a-zA-Z0-9._-]+\.json$/.test(version)) {
    throw new Error("Invalid version identifier.");
  }
  return version;
}

async function saveLocal(profileDir, payload) {
  await fs.mkdir(path.join(profileDir, "raw"), { recursive: true });
  await fs.mkdir(path.join(profileDir, "analysis"), { recursive: true });
  await fs.mkdir(path.join(profileDir, "versions"), { recursive: true });

  await fs.writeFile(path.join(profileDir, "meta.json"), json(payload.meta), "utf8");
  await fs.writeFile(path.join(profileDir, "knowledge.md"), payload.knowledgeMarkdown, "utf8");
  await fs.writeFile(path.join(profileDir, "persona.md"), payload.personaMarkdown, "utf8");
  await fs.writeFile(path.join(profileDir, "skill.md"), payload.skillMarkdown, "utf8");
  await fs.writeFile(path.join(profileDir, "wiki.md"), payload.wikiMarkdown ?? "", "utf8");
  await fs.writeFile(path.join(profileDir, "analysis", "knowledge.analysis.json"), json(payload.knowledgeAnalysis), "utf8");
  await fs.writeFile(path.join(profileDir, "analysis", "persona.analysis.json"), json(payload.personaAnalysis), "utf8");
  await fs.writeFile(path.join(profileDir, "raw", "normalized.json"), json(payload.normalizedItems ?? []), "utf8");
  if (payload.rawSource !== undefined) {
    await fs.writeFile(path.join(profileDir, "raw", "source.json"), json(payload.rawSource), "utf8");
  }
}

function profileConflict(slug) {
  return Object.assign(new Error(`Profile already exists: ${slug}`), { code: "profile_already_exists" });
}

async function createLocal(slug, profileDir, payload) {
  await fs.mkdir(PROFILE_ROOT, { recursive: true });
  const stagingDir = await fs.mkdtemp(path.join(PROFILE_ROOT, ".create-"));
  try {
    await saveLocal(stagingDir, payload);
    try {
      await fs.rename(stagingDir, profileDir);
    } catch (error) {
      if (await exists(profileDir)) throw profileConflict(slug);
      throw error;
    }
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
}

async function readBlobMeta(slug) {
  let raw;
  try {
    raw = await readBlob(profilePath(slug, "meta.json"));
  } catch (error) {
    if (isBlobNotFoundError(error)) return null;
    throw error;
  }
  const storedMeta = parseJson(raw, {}) ?? {};
  const id = storedMeta?.artifactSetId;
  if (typeof id === "string" && /^[a-f0-9-]{36}$/.test(id)) {
    return { meta: storedMeta.meta ?? {}, prefix: profilePath(slug, `artifacts/${id}/`), id };
  }
  return { meta: storedMeta, prefix: profilePath(slug, ""), id: null };
}

async function saveBlob(slug, payload, existing) {
  const id = existing ? existing.id : randomUUID();
  const prefix = existing ? existing.prefix : profilePath(slug, `artifacts/${id}/`);
  const artifacts = [
    ["knowledge.md", payload.knowledgeMarkdown],
    ["persona.md", payload.personaMarkdown],
    ["skill.md", payload.skillMarkdown],
    ["wiki.md", payload.wikiMarkdown ?? ""],
    ["analysis/knowledge.analysis.json", json(payload.knowledgeAnalysis)],
    ["analysis/persona.analysis.json", json(payload.personaAnalysis)],
    ["raw/normalized.json", json(payload.normalizedItems ?? [])]
  ];
  if (payload.rawSource !== undefined) {
    artifacts.push(["raw/source.json", json(payload.rawSource)]);
  }
  const options = { allowOverwrite: Boolean(existing) };
  const uploads = await Promise.allSettled(artifacts.map(([file, content]) =>
    writeBlob(prefix + file, content, options)
  ));
  const failure = uploads.find((result) => result.status === "rejected");
  if (failure) {
    if (!existing) await deleteStagedBlobs(prefix, artifacts);
    throw failure.reason;
  }

  // Publish complete new profiles by claiming the canonical metadata path without overwrite.
  const meta = id ? { artifactSetId: id, meta: payload.meta } : payload.meta;
  try {
    await writeBlob(profilePath(slug, "meta.json"), json(meta), options);
  } catch (error) {
    if (existing) throw error;
    const published = await readBlobMeta(slug);
    if (published?.id === id) return;
    if (published) {
      await deleteStagedBlobs(prefix, artifacts);
      throw profileConflict(slug);
    }
    // If the publication outcome is uncertain, keep staged data available to it.
    throw error;
  }
}

async function deleteStagedBlobs(prefix, artifacts) {
  await blobDeps.deleteImpl(artifacts.map(([file]) => prefix + file), { token: blobToken() }).catch(() => {});
}

async function readLocal(slug) {
  const profileDir = path.join(PROFILE_ROOT, slug);
  if (!(await exists(profileDir))) throw new Error("Profile not found");

  const [meta, knowledgeMarkdown, personaMarkdown, skillMarkdown, wikiRaw, legacyRagRaw] = await Promise.all([
    fs.readFile(path.join(profileDir, "meta.json"), "utf8"),
    fs.readFile(path.join(profileDir, "knowledge.md"), "utf8"),
    fs.readFile(path.join(profileDir, "persona.md"), "utf8"),
    fs.readFile(path.join(profileDir, "skill.md"), "utf8"),
    readTextIfExists(path.join(profileDir, "wiki.md")),
    readTextIfExists(path.join(profileDir, "rag.json"))
  ]);

  const wikiMarkdown =
    wikiRaw ??
    (legacyRagRaw ? legacyRagToWikiMarkdown(parseJson(legacyRagRaw, []), slug) : "");

  return {
    slug,
    profileDir,
    meta: parseJson(meta, {}),
    knowledgeMarkdown,
    personaMarkdown,
    skillMarkdown,
    wikiMarkdown
  };
}

async function readBlobProfile(slug) {
  const stored = await readBlobMeta(slug);
  if (!stored) throw new Error("Profile not found");
  const { meta, prefix } = stored;
  const [knowledgeMarkdown, personaMarkdown, skillMarkdown] = await Promise.all([
    readBlob(prefix + "knowledge.md"),
    readBlob(prefix + "persona.md"),
    readBlob(prefix + "skill.md")
  ]);

  let wikiMarkdown = "";
  try {
    wikiMarkdown = await readBlob(prefix + "wiki.md");
  } catch (error) {
    if (!isBlobNotFoundError(error)) throw error;
    try {
      const legacyRagRaw = await readBlob(prefix + "rag.json");
      wikiMarkdown = legacyRagToWikiMarkdown(parseJson(legacyRagRaw, []), slug);
    } catch (legacyError) {
      if (!isBlobNotFoundError(legacyError)) throw legacyError;
      wikiMarkdown = "";
    }
  }

  return {
    slug,
    profileDir: `blob://profiles/${slug}`,
    meta,
    knowledgeMarkdown,
    personaMarkdown,
    skillMarkdown,
    wikiMarkdown
  };
}

export async function readProfile(slugInput) {
  const slug = toSlug(slugInput);
  return blobEnabled() ? readBlobProfile(slug) : readLocal(slug);
}

export async function readNormalizedItems(slugInput) {
  const slug = toSlug(slugInput);
  if (blobEnabled()) {
    const stored = await readBlobMeta(slug);
    if (!stored) throw new Error("Profile not found");
    const raw = await readBlob(stored.prefix + "raw/normalized.json");
    return parseJson(raw, []);
  }
  const file = path.join(PROFILE_ROOT, slug, "raw", "normalized.json");
  const raw = await fs.readFile(file, "utf8");
  return parseJson(raw, []);
}

export async function listProfiles() {
  if (blobEnabled()) {
    const blobs = await listBlobPrefix("profiles/");
    const map = new Map();
    for (const blob of blobs) {
      const [, slug] = /^profiles\/([a-z0-9_-]+)\/meta\.json$/.exec(blob.pathname) ?? [];
      if (!slug) continue;
      const stored = await readBlobMeta(slug);
      if (!stored) continue;
      const { meta } = stored;
      map.set(slug, {
        slug,
        name: meta.name,
        updated_at: meta.updated_at,
        mode: meta.mode,
        source_count: meta.source_count
      });
    }
    return [...map.values()].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  }

  await fs.mkdir(PROFILE_ROOT, { recursive: true });
  const entries = await fs.readdir(PROFILE_ROOT, { withFileTypes: true });
  const slugs = entries.filter((x) => x.isDirectory() && !x.name.startsWith(".")).map((x) => x.name);
  const results = [];
  for (const slug of slugs) {
    const metaPath = path.join(PROFILE_ROOT, slug, "meta.json");
    if (!(await exists(metaPath))) continue;
    const meta = parseJson(await fs.readFile(metaPath, "utf8"), {});
    results.push({
      slug,
      name: meta.name,
      updated_at: meta.updated_at,
      mode: meta.mode,
      source_count: meta.source_count
    });
  }
  return results.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

export async function backupProfileStore(slugInput) {
  const slug = toSlug(slugInput);
  const profile = await readProfile(slug);
  const versionId = `${toVersionId()}.json`;
  const snapshot = {
    slug,
    createdAt: new Date().toISOString(),
    profile
  };

  if (blobEnabled()) {
    await writeBlob(profilePath(slug, `versions/${versionId}`), json(snapshot));
  } else {
    const versionDir = path.join(PROFILE_ROOT, slug, "versions");
    await fs.mkdir(versionDir, { recursive: true });
    await fs.writeFile(path.join(versionDir, versionId), json(snapshot), "utf8");
  }
  return versionId;
}

export async function listProfileVersions(slugInput) {
  const slug = toSlug(slugInput);
  if (blobEnabled()) {
    const blobs = await listBlobPrefix(profilePath(slug, "versions/"));
    return blobs
      .map((x) => x.pathname.split("/").pop())
      .filter(Boolean)
      .sort()
      .reverse();
  }

  const versionDir = path.join(PROFILE_ROOT, slug, "versions");
  if (!(await exists(versionDir))) return [];
  const files = await fs.readdir(versionDir);
  return files.filter((x) => x.endsWith(".json")).sort().reverse();
}

export async function rollbackProfileStore(slugInput, version) {
  const slug = toSlug(slugInput);
  const safeVersion = assertSafeVersionFilename(version);
  let snapshotRaw;
  if (blobEnabled()) {
    snapshotRaw = await readBlob(profilePath(slug, `versions/${safeVersion}`));
  } else {
    const versionDir = path.join(PROFILE_ROOT, slug, "versions");
    const versionFile = path.resolve(versionDir, safeVersion);
    if (!versionFile.startsWith(path.resolve(versionDir) + path.sep)) {
      throw new Error("Invalid version identifier.");
    }
    snapshotRaw = await fs.readFile(versionFile, "utf8");
  }
  const snapshot = parseJson(snapshotRaw, null);
  if (!snapshot?.profile) throw new Error("Invalid snapshot");

  const profile = snapshot.profile;
  await saveProfile({
    slug,
    meta: profile.meta,
    knowledgeMarkdown: profile.knowledgeMarkdown,
    personaMarkdown: profile.personaMarkdown,
    skillMarkdown: profile.skillMarkdown,
    wikiMarkdown: profile.wikiMarkdown ?? legacyRagToWikiMarkdown(profile.rag, slug),
    knowledgeAnalysis: {},
    personaAnalysis: {},
    normalizedItems: await readNormalizedItems(slug).catch(() => [])
  });
  return { restored: true, version: safeVersion };
}

export async function saveProfile(payload, { createOnly = false } = {}) {
  const slug = toSlug(payload.slug);
  const useBlob = blobEnabled();
  const profileDir = useBlob ? `blob://profiles/${slug}` : path.join(PROFILE_ROOT, slug);
  const existing = useBlob ? await readBlobMeta(slug) : await exists(profileDir);
  if (existing && createOnly) throw profileConflict(slug);
  if (existing) await backupProfileStore(slug);

  if (useBlob) {
    await saveBlob(slug, payload, existing);
  } else if (existing) {
    await saveLocal(profileDir, payload);
  } else {
    await createLocal(slug, profileDir, payload);
  }

  return {
    slug,
    profileDir,
    alreadyExists: Boolean(existing),
    storage: useBlob ? "blob" : "filesystem"
  };
}

export async function applyProfileCorrection(slugInput, scope, correction) {
  const slug = toSlug(slugInput);
  const profile = await readProfile(slug);
  await backupProfileStore(slug);

  const now = new Date().toISOString();
  const appendText = `\n\n## Correction Log\n- ${now}: ${correction}\n`;
  const knowledgeMarkdown =
    scope === "knowledge" ? `${profile.knowledgeMarkdown}${appendText}` : profile.knowledgeMarkdown;
  const personaMarkdown =
    scope === "persona" ? `${profile.personaMarkdown}${appendText}` : profile.personaMarkdown;

  const meta = {
    ...profile.meta,
    updated_at: now,
    corrections_count: Number(profile.meta.corrections_count || 0) + 1
  };

  const skillMarkdown = buildSkillMarkdown({
    slug,
    name: meta.name || slug,
    language: meta.language || "en",
    knowledgeType: "WordPress knowledge profile",
    primaryTopics: (meta.knowledge_topics || []).slice(0, 3),
    optionalIdentity: "",
    descriptionParts: [meta.name || slug, meta.knowledge_topics?.[0] || "general", "corrected"],
    knowledgeMarkdown,
    personaMarkdown
  });

  await saveProfile({
    slug,
    meta,
    knowledgeMarkdown,
    personaMarkdown,
    skillMarkdown,
    wikiMarkdown: profile.wikiMarkdown ?? legacyRagToWikiMarkdown(profile.rag, slug),
    knowledgeAnalysis: {},
    personaAnalysis: {},
    normalizedItems: await readNormalizedItems(slug).catch(() => [])
  });

  return {
    slug,
    scope,
    correction,
    corrections_count: meta.corrections_count
  };
}
