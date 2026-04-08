import fs from "node:fs/promises";
import path from "node:path";
import { buildSkillMarkdown } from "../src/skill_template.js";

async function readJson(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
}

export async function assembleSkillFromProfile(slug, baseDir = path.resolve(process.cwd(), "profiles")) {
  const profileDir = path.join(baseDir, slug);
  const meta = await readJson(path.join(profileDir, "meta.json"));
  const knowledgeMarkdown = await fs.readFile(path.join(profileDir, "knowledge.md"), "utf8");
  const personaMarkdown = await fs.readFile(path.join(profileDir, "persona.md"), "utf8");

  const skillMarkdown = buildSkillMarkdown({
    slug,
    name: meta.name || slug,
    language: meta.language || "en",
    knowledgeType: "WordPress knowledge profile",
    primaryTopics: (meta.knowledge_topics || []).slice(0, 3),
    optionalIdentity: "",
    descriptionParts: [
      meta.name || slug,
      meta.knowledge_topics?.[0] || "general knowledge",
      meta.tags?.tone?.[0] || "balanced"
    ],
    knowledgeMarkdown,
    personaMarkdown
  });

  const outPath = path.join(profileDir, "skill.md");
  await fs.writeFile(outPath, skillMarkdown, "utf8");
  return outPath;
}

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    // eslint-disable-next-line no-console
    console.log("Usage: node node_tools/skill_writer.js <slug>");
    process.exit(1);
  }
  const out = await assembleSkillFromProfile(slug);
  // eslint-disable-next-line no-console
  console.log(out);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error.message);
    process.exit(1);
  });
}
