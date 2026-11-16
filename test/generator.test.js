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

test("buildProfileArtifacts uses a bounded AI request and reads the completed result", async (t) => {
  const oldKey = process.env.OPENAI_API_KEY;
  const oldFetch = global.fetch;
  process.env.OPENAI_API_KEY = "fake-key";
  t.after(() => {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
    global.fetch = oldFetch;
  });

  let request;
  global.fetch = async (_url, options) => {
    request = options;
    return new Response(JSON.stringify({
      status: "completed",
      output_text: "# AI Skill\n\ncustom output"
    }));
  };

  const artifacts = await buildProfileArtifacts({
    slug: "leo-ai",
    name: "Leo AI",
    items: sampleItems,
    options: { mode: "ai", language: "en" }
  });

  assert.equal(artifacts.metadata.modeUsed, "ai");
  assert.equal(artifacts.metadata.aiUsed, true);
  assert.ok(artifacts.skillMarkdown.includes("# AI Skill"));
  assert.ok(request.signal instanceof AbortSignal);
  assert.equal(JSON.parse(request.body).max_output_tokens, 4096);
});

test("buildProfileArtifacts keeps the parser output when the AI prompt exceeds its byte budget", async (t) => {
  const oldKey = process.env.OPENAI_API_KEY;
  const oldFetch = global.fetch;
  process.env.OPENAI_API_KEY = "fake-key";
  t.after(() => {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
    global.fetch = oldFetch;
  });

  let requests = 0;
  global.fetch = async () => {
    requests += 1;
  };
  const artifacts = await buildProfileArtifacts({
    slug: "leo-ai",
    name: "測".repeat(24_000),
    items: sampleItems,
    options: { mode: "ai", language: "en" }
  });

  assert.equal(requests, 0);
  assert.equal(artifacts.metadata.aiUsed, false);
  assert.ok(artifacts.skillMarkdown.includes("## PART A: Knowledge"));
});

test("buildProfileArtifacts keeps the parser output when the response body times out", async (t) => {
  const oldKey = process.env.OPENAI_API_KEY;
  const oldFetch = global.fetch;
  const oldTimeout = AbortSignal.timeout;
  process.env.OPENAI_API_KEY = "fake-key";
  t.after(() => {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
    global.fetch = oldFetch;
    AbortSignal.timeout = oldTimeout;
  });

  let timeout;
  const controller = new AbortController();
  AbortSignal.timeout = (ms) => {
    timeout = ms;
    return controller.signal;
  };
  global.fetch = async (_url, { signal }) => ({
    ok: true,
    async json() {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        controller.abort();
      });
    }
  });

  const artifacts = await buildProfileArtifacts({
    slug: "leo-ai",
    name: "Leo AI",
    items: sampleItems,
    options: { mode: "ai", language: "en" }
  });

  assert.equal(timeout, 20_000);
  assert.equal(artifacts.metadata.aiUsed, false);
  assert.ok(artifacts.skillMarkdown.includes("## PART A: Knowledge"));
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
  assert.ok(typeof out.wikiMarkdown === "string");
  assert.ok(out.wikiMarkdown.includes("# Wiki"));

  if (oldKey) process.env.OPENAI_API_KEY = oldKey;
});

test("buildProfileArtifacts renders Traditional Chinese sections when zh-TW is selected", async () => {
  const oldKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  const artifacts = await buildProfileArtifacts({
    slug: "leo-zh",
    name: "Leo 中文",
    items: sampleItems,
    options: { mode: "parser", language: "zh-TW" }
  });

  assert.equal(artifacts.metadata.modeUsed, "parser");
  assert.ok(artifacts.skillMarkdown.includes("## PART A: 知識庫"));
  assert.ok(artifacts.skillMarkdown.includes("## PART B: 人設風格"));
  assert.ok(artifacts.knowledgeMarkdown.includes("### 核心主題"));
  assert.ok(artifacts.personaMarkdown.includes("### 語氣與風格"));

  if (oldKey) process.env.OPENAI_API_KEY = oldKey;
});
