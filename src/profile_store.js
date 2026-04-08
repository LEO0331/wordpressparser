import fs from "node:fs/promises";
import path from "node:path";
import { backupProfile } from "../node_tools/version_manager.js";

const PROFILE_ROOT = path.resolve(process.cwd(), "profiles");

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

export async function saveProfile(payload) {
  const slug = toSlug(payload.slug);
  const profileDir = path.join(PROFILE_ROOT, slug);
  const alreadyExists = await exists(profileDir);
  if (alreadyExists) {
    await backupProfile(slug, PROFILE_ROOT);
  }

  await fs.mkdir(path.join(profileDir, "raw"), { recursive: true });
  await fs.mkdir(path.join(profileDir, "analysis"), { recursive: true });
  await fs.mkdir(path.join(profileDir, "versions"), { recursive: true });

  await fs.writeFile(path.join(profileDir, "meta.json"), JSON.stringify(payload.meta, null, 2), "utf8");
  await fs.writeFile(path.join(profileDir, "knowledge.md"), payload.knowledgeMarkdown, "utf8");
  await fs.writeFile(path.join(profileDir, "persona.md"), payload.personaMarkdown, "utf8");
  await fs.writeFile(path.join(profileDir, "skill.md"), payload.skillMarkdown, "utf8");
  await fs.writeFile(path.join(profileDir, "rag.json"), JSON.stringify(payload.rag, null, 2), "utf8");
  await fs.writeFile(
    path.join(profileDir, "analysis", "knowledge.analysis.json"),
    JSON.stringify(payload.knowledgeAnalysis, null, 2),
    "utf8"
  );
  await fs.writeFile(
    path.join(profileDir, "analysis", "persona.analysis.json"),
    JSON.stringify(payload.personaAnalysis, null, 2),
    "utf8"
  );

  if (payload.rawSource !== undefined) {
    await fs.writeFile(path.join(profileDir, "raw", "source.json"), JSON.stringify(payload.rawSource, null, 2), "utf8");
  }
  if (payload.normalizedItems !== undefined) {
    await fs.writeFile(
      path.join(profileDir, "raw", "normalized.json"),
      JSON.stringify(payload.normalizedItems, null, 2),
      "utf8"
    );
  }

  return {
    slug,
    profileDir,
    alreadyExists
  };
}

export async function listProfiles() {
  await fs.mkdir(PROFILE_ROOT, { recursive: true });
  const entries = await fs.readdir(PROFILE_ROOT, { withFileTypes: true });
  const slugs = entries.filter((x) => x.isDirectory()).map((x) => x.name);
  const results = [];
  for (const slug of slugs) {
    const metaPath = path.join(PROFILE_ROOT, slug, "meta.json");
    if (!(await exists(metaPath))) continue;
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
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

export async function readProfile(slugInput) {
  const slug = toSlug(slugInput);
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
    meta: JSON.parse(meta),
    knowledgeMarkdown,
    personaMarkdown,
    skillMarkdown,
    rag: JSON.parse(ragRaw)
  };
}
