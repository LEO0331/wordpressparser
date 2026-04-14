import test from "node:test";
import assert from "node:assert/strict";
import { buildSkillMarkdown } from "../src/skill_template.js";

test("buildSkillMarkdown renders frontmatter and key sections", () => {
  const md = buildSkillMarkdown({
    slug: "leo",
    name: "Leo",
    descriptionParts: ["Leo", "investing"],
    language: "en",
    knowledgeType: "WordPress knowledge profile",
    primaryTopics: ["Investing", "Risk"],
    optionalIdentity: "INTJ",
    knowledgeMarkdown: "knowledge content",
    personaMarkdown: "persona content"
  });

  assert.ok(md.includes("name: knowledge-leo"));
  assert.ok(md.includes("## Profile Snapshot"));
  assert.ok(md.includes("## PART A: Knowledge"));
  assert.ok(md.includes("knowledge content"));
  assert.ok(md.includes("## PART B: Persona"));
  assert.ok(md.includes("persona content"));
  assert.ok(md.includes("## Response Checklist"));
});
