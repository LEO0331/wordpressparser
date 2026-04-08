import fs from "node:fs/promises";
import path from "node:path";
import { put, list } from "@vercel/blob";
import { buildSkillMarkdown } from "./skill_template.js";

const PROFILE_ROOT = path.resolve(process.cwd(), "profiles");

function blobEnabled() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN;
}

function json(value) {
  return JSON.stringify(value, null, 2);
}

function parseJson(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function toVersionId() {
  return `v-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
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

async function writeBlob(pathname, content) {
  await put(pathname, content, {
    access: "public",
    addRandomSuffix: false,
    token: blobToken()
  });
}

async function readBlob(pathname) {
  const result = await list({
    prefix: pathname,
    token: blobToken()
  });
  const match = result.blobs.find((x) => x.pathname === pathname);
  if (!match) throw new Error(`Blob not found: ${pathname}`);
  const res = await fetch(match.url);
  if (!res.ok) throw new Error(`Failed to fetch blob: ${pathname}`);
  return res.text();
}

async function listBlobPrefix(prefix) {
  const result = await list({
    prefix,
    token: blobToken()
  });
  return result.blobs ?? [];
}

function profilePath(slug, file) {
  return `profiles/${slug}/${file}`;
}

async function saveLocal(slug, payload) {
  const profileDir = path.join(PROFILE_ROOT, slug);
  await fs.mkdir(path.join(profileDir, "raw"), { recursive: true });
  await fs.mkdir(path.join(profileDir, "analysis"), { recursive: true });
  await fs.mkdir(path.join(profileDir, "versions"), { recursive: true });

  await fs.writeFile(path.join(profileDir, "meta.json"), json(payload.meta), "utf8");
  await fs.writeFile(path.join(profileDir, "knowledge.md"), payload.knowledgeMarkdown, "utf8");
  await fs.writeFile(path.join(profileDir, "persona.md"), payload.personaMarkdown, "utf8");
  await fs.writeFile(path.join(profileDir, "skill.md"), payload.skillMarkdown, "utf8");
  await fs.writeFile(path.join(profileDir, "rag.json"), json(payload.rag), "utf8");
  await fs.writeFile(path.join(profileDir, "analysis", "knowledge.analysis.json"), json(payload.knowledgeAnalysis), "utf8");
  await fs.writeFile(path.join(profileDir, "analysis", "persona.analysis.json"), json(payload.personaAnalysis), "utf8");
  await fs.writeFile(path.join(profileDir, "raw", "normalized.json"), json(payload.normalizedItems ?? []), "utf8");
  if (payload.rawSource !== undefined) {
    await fs.writeFile(path.join(profileDir, "raw", "source.json"), json(payload.rawSource), "utf8");
  }
}

async function saveBlob(slug, payload) {
  await Promise.all([
    writeBlob(profilePath(slug, "meta.json"), json(payload.meta)),
    writeBlob(profilePath(slug, "knowledge.md"), payload.knowledgeMarkdown),
    writeBlob(profilePath(slug, "persona.md"), payload.personaMarkdown),
    writeBlob(profilePath(slug, "skill.md"), payload.skillMarkdown),
    writeBlob(profilePath(slug, "rag.json"), json(payload.rag)),
    writeBlob(profilePath(slug, "analysis/knowledge.analysis.json"), json(payload.knowledgeAnalysis)),
    writeBlob(profilePath(slug, "analysis/persona.analysis.json"), json(payload.personaAnalysis)),
    writeBlob(profilePath(slug, "raw/normalized.json"), json(payload.normalizedItems ?? []))
  ]);
  if (payload.rawSource !== undefined) {
    await writeBlob(profilePath(slug, "raw/source.json"), json(payload.rawSource));
  }
}

async function readLocal(slug) {
  const profileDir = path.join(PROFILE_ROOT, slug);
  if (!(await exists(profileDir))) throw new Error("Profile not found");

  const [meta, knowledgeMarkdown, personaMarkdown, skillMarkdown, ragRaw] = await Promise.all([
    fs.readFile(path.join(profileDir, "meta.json"), "utf8"),
    fs.readFile(path.join(profileDir, "knowledge.md"), "utf8"),
    fs.readFile(path.join(profileDir, "persona.md"), "utf8"),
    fs.readFile(path.join(profileDir, "skill.md"), "utf8"),
    fs.readFile(path.join(profileDir, "rag.json"), "utf8")
  ]);

  return {
    slug,
    profileDir,
    meta: parseJson(meta, {}),
    knowledgeMarkdown,
    personaMarkdown,
    skillMarkdown,
    rag: parseJson(ragRaw, [])
  };
}

async function readBlobProfile(slug) {
  const [meta, knowledgeMarkdown, personaMarkdown, skillMarkdown, ragRaw] = await Promise.all([
    readBlob(profilePath(slug, "meta.json")),
    readBlob(profilePath(slug, "knowledge.md")),
    readBlob(profilePath(slug, "persona.md")),
    readBlob(profilePath(slug, "skill.md")),
    readBlob(profilePath(slug, "rag.json"))
  ]);

  return {
    slug,
    profileDir: `blob://profiles/${slug}`,
    meta: parseJson(meta, {}),
    knowledgeMarkdown,
    personaMarkdown,
    skillMarkdown,
    rag: parseJson(ragRaw, [])
  };
}

export async function readProfile(slugInput) {
  const slug = toSlug(slugInput);
  return blobEnabled() ? readBlobProfile(slug) : readLocal(slug);
}

export async function readNormalizedItems(slugInput) {
  const slug = toSlug(slugInput);
  if (blobEnabled()) {
    const raw = await readBlob(profilePath(slug, "raw/normalized.json"));
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
      if (!blob.pathname.endsWith("/meta.json")) continue;
      const slug = blob.pathname.split("/")[1];
      if (!slug) continue;
      const metaRaw = await fetch(blob.url).then((r) => r.text());
      const meta = parseJson(metaRaw, {});
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
  const slugs = entries.filter((x) => x.isDirectory()).map((x) => x.name);
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
  let snapshotRaw;
  if (blobEnabled()) {
    snapshotRaw = await readBlob(profilePath(slug, `versions/${version}`));
  } else {
    snapshotRaw = await fs.readFile(path.join(PROFILE_ROOT, slug, "versions", version), "utf8");
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
    rag: profile.rag,
    knowledgeAnalysis: {},
    personaAnalysis: {},
    normalizedItems: await readNormalizedItems(slug).catch(() => [])
  });
  return { restored: true, version };
}

export async function saveProfile(payload) {
  const slug = toSlug(payload.slug);
  let alreadyExists = false;
  try {
    await readProfile(slug);
    alreadyExists = true;
  } catch {
    alreadyExists = false;
  }
  if (alreadyExists) {
    await backupProfileStore(slug);
  }

  if (blobEnabled()) {
    await saveBlob(slug, payload);
  } else {
    await saveLocal(slug, payload);
  }

  return {
    slug,
    profileDir: blobEnabled() ? `blob://profiles/${slug}` : path.join(PROFILE_ROOT, slug),
    alreadyExists,
    storage: blobEnabled() ? "blob" : "filesystem"
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
    rag: profile.rag,
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
