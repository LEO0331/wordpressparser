import fs from "node:fs/promises";
import path from "node:path";

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readFileIfExists(filePath) {
  if (!(await exists(filePath))) return null;
  return fs.readFile(filePath, "utf8");
}

function nextVersion(existingCount) {
  return `v${existingCount + 1}`;
}

export async function backupProfile(slug, baseDir = path.resolve(process.cwd(), "profiles")) {
  const profileDir = path.join(baseDir, slug);
  if (!(await exists(profileDir))) {
    throw new Error(`Profile not found: ${slug}`);
  }

  const versionsDir = path.join(profileDir, "versions");
  await fs.mkdir(versionsDir, { recursive: true });

  const files = [
    "meta.json",
    "skill.md",
    "knowledge.md",
    "persona.md",
    "wiki.md",
    "rag.json",
    path.join("analysis", "knowledge.analysis.json"),
    path.join("analysis", "persona.analysis.json")
  ];

  const snapshot = {
    slug,
    createdAt: new Date().toISOString(),
    files: {}
  };

  for (const rel of files) {
    const content = await readFileIfExists(path.join(profileDir, rel));
    if (content !== null) snapshot.files[rel] = content;
  }

  const entries = await fs.readdir(versionsDir).catch(() => []);
  const versionLabel = `${nextVersion(entries.length)}-${nowStamp()}.json`;
  const outPath = path.join(versionsDir, versionLabel);
  await fs.writeFile(outPath, JSON.stringify(snapshot, null, 2), "utf8");
  return { version: versionLabel, path: outPath };
}

export async function rollbackProfile(
  slug,
  version,
  baseDir = path.resolve(process.cwd(), "profiles")
) {
  const profileDir = path.join(baseDir, slug);
  const versionPath = path.join(profileDir, "versions", version);
  if (!(await exists(versionPath))) {
    throw new Error(`Version not found: ${version}`);
  }
  const raw = await fs.readFile(versionPath, "utf8");
  const snapshot = JSON.parse(raw);
  const files = snapshot.files || {};

  for (const [rel, content] of Object.entries(files)) {
    const fullPath = path.join(profileDir, rel);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, String(content), "utf8");
  }

  return { restored: Object.keys(files).length, version };
}

export async function listVersions(slug, baseDir = path.resolve(process.cwd(), "profiles")) {
  const versionsDir = path.join(baseDir, slug, "versions");
  if (!(await exists(versionsDir))) return [];
  const files = await fs.readdir(versionsDir);
  return files.filter((x) => x.endsWith(".json")).sort().reverse();
}

async function main() {
  const args = process.argv.slice(2);
  const action = args[0];
  const slug = args[1];
  const version = args[2];

  if (!action || !slug) {
    // eslint-disable-next-line no-console
    console.log("Usage: node node_tools/version_manager.js <backup|rollback|list> <slug> [version]");
    process.exit(1);
  }

  if (action === "backup") {
    const result = await backupProfile(slug);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (action === "rollback") {
    if (!version) throw new Error("rollback requires version");
    const result = await rollbackProfile(slug, version);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (action === "list") {
    const result = await listVersions(slug);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`Unknown action: ${action}`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error.message);
    process.exit(1);
  });
}
