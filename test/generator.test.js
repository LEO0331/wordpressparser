import test from "node:test";
import assert from "node:assert/strict";
import { analyzeCorpus, buildProfileArtifacts, generateArtifacts } from "../src/generator.js";

const sampleItems = [
  {
    title: "投資思考 01",
    content: "投資要有紀律。Risk control first. 先定義邊界再追求報酬。",
    date: "2026-01-01",
    url: "https://example.com/1",
    categories: ["投資"],
    tags: ["risk"]
  },
  {
    title: "投資思考 02",
    content: "Long term compounding matters. 每年檢查資產配置與風險。",
    date: "2026-02-01",
    url: "https://example.com/2",
    categories: ["投資"],
    tags: ["allocation"]
  }
];

test("analyzeCorpus resolves language and returns both tracks", () => {
  const result = analyzeCorpus(sampleItems, { language: "auto" });
  assert.ok(result.metadata.language === "zh-TW" || result.metadata.language === "en");
  assert.ok(Array.isArray(result.knowledgeAnalysis.coreTopics));
  assert.ok(result.personaAnalysis.voice.tone.length > 0);
});

test("buildProfileArtifacts falls back to parser mode without API key", async () => {
  const oldKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  const artifacts = await buildProfileArtifacts({
    slug: "leo",
    name: "Leo",
    items: sampleItems,
    options: { mode: "ai", language: "en" }
  });

  assert.equal(artifacts.metadata.modeUsed, "parser");
  assert.equal(artifacts.metadata.aiUsed, false);
  assert.ok(artifacts.skillMarkdown.includes("## PART A: Knowledge"));

  if (oldKey) process.env.OPENAI_API_KEY = oldKey;
});

test("buildProfileArtifacts uses AI result when API call succeeds", async () => {
  const oldKey = process.env.OPENAI_API_KEY;
  const oldFetch = global.fetch;
  process.env.OPENAI_API_KEY = "fake-key";

  global.fetch = async () =>
    ({
      ok: true,
      async json() {
        return {
          output_text: "# AI Skill\n\ncustom output"
        };
      }
    });

  const artifacts = await buildProfileArtifacts({
    slug: "leo-ai",
    name: "Leo AI",
    items: sampleItems,
    options: { mode: "ai", language: "en" }
  });

  assert.equal(artifacts.metadata.modeUsed, "ai");
  assert.equal(artifacts.metadata.aiUsed, true);
  assert.ok(artifacts.skillMarkdown.includes("# AI Skill"));

  if (oldKey) process.env.OPENAI_API_KEY = oldKey;
  else delete process.env.OPENAI_API_KEY;
  global.fetch = oldFetch;
});

test("generateArtifacts remains backward compatible", async () => {
  const oldKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  const out = await generateArtifacts(sampleItems, {
    slug: "legacy",
    name: "Legacy",
    mode: "parser"
  });
  assert.ok(typeof out.skillMarkdown === "string");
  assert.ok(Array.isArray(out.rag));

  if (oldKey) process.env.OPENAI_API_KEY = oldKey;
});
