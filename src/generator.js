import { buildRagChunks, collectCorpusStats } from "./parser.js";
import { buildSkillMarkdown } from "./skill_template.js";

const LANGUAGE_WHITELIST = new Set(["en", "zh-TW", "auto"]);
const LOCALE = {
  en: {
    knowledgeIntro: "This section captures knowledge priorities distilled from WordPress sources.",
    personaIntro: "This section captures writing tone, style, and structure preferences.",
    headingOverview: "### Overview",
    headingCorpus: "### Corpus",
    headingTopics: "### Core Topics",
    headingClaims: "### Canonical Claims",
    headingTerms: "### Domain Terms",
    headingEvidence: "### Evidence Posts",
    headingVoice: "### Voice",
    headingFormatting: "### Formatting",
    headingPatterns: "### Reasoning Patterns",
    headingGuardrails: "### Guardrails",
    labelItemCount: "Item count",
    labelAvgLength: "Average length (chars)",
    labelDateRange: "Date range",
    labelLanguage: "Language",
    labelTone: "Tone",
    labelConfidence: "Confidence",
    labelPace: "Pace",
    labelStructuredLists: "Structured lists preferred",
    labelAvgPostLength: "Avg post length (chars)",
    labelAvgSentenceLength: "Avg sentence length (chars)",
    unknown: "unknown",
    none: "none",
    dateConnector: "to",
    canonicalClaims: [
      "derive recurring claims from source posts",
      "prefer explicit statements over inferred assumptions",
      "bind claims to evidence posts when possible"
    ],
    reasoningPatterns: [
      "state core claim",
      "provide explanation or framework",
      "end with practical takeaway"
    ],
    guardrails: [
      "do not fabricate facts beyond source material",
      "mark uncertainty when evidence is weak",
      "keep output in English or Traditional Chinese"
    ],
    voiceMap: {
      "longform-analytical": "longform-analytical",
      "concise-practical": "concise-practical",
      assertive: "assertive",
      balanced: "balanced",
      measured: "measured",
      direct: "direct"
    }
  },
  "zh-TW": {
    knowledgeIntro: "此段整理自 WordPress 語料，聚焦可重用的知識重點。",
    personaIntro: "此段整理作者語氣、風格與結構偏好。",
    headingOverview: "### 概覽",
    headingCorpus: "### 語料概況",
    headingTopics: "### 核心主題",
    headingClaims: "### 關鍵主張",
    headingTerms: "### 領域詞彙",
    headingEvidence: "### 證據文章",
    headingVoice: "### 語氣與風格",
    headingFormatting: "### 格式偏好",
    headingPatterns: "### 推理模式",
    headingGuardrails: "### 輸出守則",
    labelItemCount: "條目數",
    labelAvgLength: "平均長度（字元）",
    labelDateRange: "日期範圍",
    labelLanguage: "語言",
    labelTone: "語氣",
    labelConfidence: "立場強度",
    labelPace: "節奏",
    labelStructuredLists: "偏好條列結構",
    labelAvgPostLength: "平均文章長度（字元）",
    labelAvgSentenceLength: "平均句長（字元）",
    unknown: "未知",
    none: "無",
    dateConnector: "至",
    canonicalClaims: [
      "從原始文章歸納重複出現的核心主張",
      "優先採用明確敘述，避免過度推論",
      "可行時將主張綁定到具體證據文章"
    ],
    reasoningPatterns: [
      "先提出核心觀點",
      "補上脈絡、框架或推導過程",
      "最後收斂為可執行的建議"
    ],
    guardrails: [
      "不得捏造超出來源語料的事實",
      "當證據不足時必須清楚標示不確定性",
      "輸出語言僅限英文或繁體中文"
    ],
    voiceMap: {
      "longform-analytical": "長篇分析",
      "concise-practical": "精簡務實",
      assertive: "明確",
      balanced: "平衡",
      measured: "穩健",
      direct: "直接"
    }
  }
};

function normalizeLanguage(language) {
  if (!language) return "auto";
  if (LANGUAGE_WHITELIST.has(language)) return language;
  const normalized = String(language).toLowerCase();
  if (normalized.includes("traditional")) return "zh-TW";
  if (normalized.startsWith("zh")) return "zh-TW";
  if (normalized.startsWith("en")) return "en";
  return "auto";
}

function detectLanguageFromItems(items) {
  const sample = items.slice(0, 20).map((x) => x.content).join(" ");
  const cjk = (sample.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = (sample.match(/[a-zA-Z]/g) ?? []).length;
  return cjk > latin ? "zh-TW" : "en";
}

function extractTopicCandidates(items, stats) {
  const fromTags = [];
  const seen = new Set();
  for (const item of items) {
    const tokens = [...(item.categories ?? []), ...(item.tags ?? [])];
    for (const token of tokens) {
      const value = String(token || "").trim();
      if (!value) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      fromTags.push(value);
      if (fromTags.length >= 12) break;
    }
    if (fromTags.length >= 12) break;
  }

  const fromKeywords = stats.topKeywords.slice(0, 15).map((x) => x.word);
  return [...fromTags, ...fromKeywords].slice(0, 12);
}

function toSentenceCount(text) {
  const count = (text.match(/[.!?。！？]/g) ?? []).length;
  return Math.max(count, 1);
}

function analyzePersona(items, language) {
  const sample = items.slice(0, 40);
  const lengths = sample.map((x) => x.content.length);
  const avgLen = lengths.length
    ? Math.round(lengths.reduce((sum, value) => sum + value, 0) / lengths.length)
    : 0;

  let sentenceChars = 0;
  let sentenceCount = 0;
  for (const item of sample) {
    sentenceChars += item.content.length;
    sentenceCount += toSentenceCount(item.content);
  }
  const avgSentenceLength = sentenceCount ? Math.round(sentenceChars / sentenceCount) : 0;

  const usesNumberedRhythm = sample.some((x) => /\d+/.test(x.content));
  const confidence = sample.some((x) => /(must|never|always|should|一定|必须|不要)/i.test(x.content))
    ? "assertive"
    : "balanced";
  const locale = LOCALE[language] ?? LOCALE.en;

  return {
    voice: {
      language,
      tone: avgLen > 1200 ? "longform-analytical" : "concise-practical",
      confidence,
      pace: avgSentenceLength > 45 ? "measured" : "direct"
    },
    formatting: {
      prefersStructuredLists: usesNumberedRhythm,
      avgPostLengthChars: avgLen,
      avgSentenceLengthChars: avgSentenceLength
    },
    reasoningPatterns: locale.reasoningPatterns,
    guardrails: locale.guardrails
  };
}

function analyzeKnowledge(items, stats, language) {
  const locale = LOCALE[language] ?? LOCALE.en;
  const topics = extractTopicCandidates(items, stats);
  const evidencePosts = items.slice(0, 12).map((item) => ({
    title: item.title,
    date: item.date,
    url: item.url
  }));

  return {
    corpus: {
      itemCount: stats.count,
      dateRange: {
        start: stats.minDate,
        end: stats.maxDate
      },
      avgChars: stats.avgChars
    },
    coreTopics: topics,
    canonicalClaims: locale.canonicalClaims,
    domainTerms: stats.topKeywords.slice(0, 30).map((x) => x.word),
    evidencePosts
  };
}

function buildKnowledgeMarkdown(analysis, language) {
  const locale = LOCALE[language] ?? LOCALE.en;
  const topicLine = analysis.coreTopics.length ? analysis.coreTopics.join(", ") : locale.none;
  const terms = analysis.domainTerms.slice(0, 20).join(", ");
  const dateStart = analysis.corpus.dateRange.start ?? locale.unknown;
  const dateEnd = analysis.corpus.dateRange.end ?? locale.unknown;

  return `${locale.headingOverview}
${locale.knowledgeIntro}

${locale.headingCorpus}
- ${locale.labelItemCount}: ${analysis.corpus.itemCount}
- ${locale.labelAvgLength}: ${analysis.corpus.avgChars}
- ${locale.labelDateRange}: ${dateStart} ${locale.dateConnector} ${dateEnd}

${locale.headingTopics}
${topicLine}

${locale.headingClaims}
${analysis.canonicalClaims.map((x) => `- ${x}`).join("\n")}

${locale.headingTerms}
${terms || locale.none}

${locale.headingEvidence}
${analysis.evidencePosts
  .slice(0, 10)
  .map((x) => `- ${x.title} (${x.date ?? locale.unknown}) ${x.url ?? ""}`.trim())
  .join("\n")}
`;
}

function buildPersonaMarkdown(analysis, language) {
  const locale = LOCALE[language] ?? LOCALE.en;
  const localizeVoice = (value) => locale.voiceMap[value] ?? value;
  const boolValue = analysis.formatting.prefersStructuredLists
    ? language === "zh-TW"
      ? "是"
      : "true"
    : language === "zh-TW"
      ? "否"
      : "false";

  return `${locale.headingOverview}
${locale.personaIntro}

${locale.headingVoice}
- ${locale.labelLanguage}: ${analysis.voice.language}
- ${locale.labelTone}: ${localizeVoice(analysis.voice.tone)}
- ${locale.labelConfidence}: ${localizeVoice(analysis.voice.confidence)}
- ${locale.labelPace}: ${localizeVoice(analysis.voice.pace)}

${locale.headingFormatting}
- ${locale.labelStructuredLists}: ${boolValue}
- ${locale.labelAvgPostLength}: ${analysis.formatting.avgPostLengthChars}
- ${locale.labelAvgSentenceLength}: ${analysis.formatting.avgSentenceLengthChars}

${locale.headingPatterns}
${analysis.reasoningPatterns.map((x) => `- ${x}`).join("\n")}

${locale.headingGuardrails}
${analysis.guardrails.map((x) => `- ${x}`).join("\n")}
`;
}

function extractResponseText(responseJson) {
  if (typeof responseJson?.output_text === "string" && responseJson.output_text.trim()) {
    return responseJson.output_text.trim();
  }

  const output = responseJson?.output;
  if (!Array.isArray(output)) return "";
  const lines = [];
  for (const item of output) {
    const content = item?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (typeof c?.text === "string") lines.push(c.text);
    }
  }
  return lines.join("\n").trim();
}

async function callModel(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      input: prompt
    })
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Model request failed (${response.status}): ${errorText}`);
  }
  const body = await response.json();
  return extractResponseText(body);
}

function buildAiPrompt({ slug, name, knowledgeMarkdown, personaMarkdown, language }) {
  const languageInstruction =
    language === "zh-TW"
      ? "Output every heading and sentence in Traditional Chinese only (do not mix English except URLs and proper nouns)."
      : "Output every heading and sentence in English only.";
  return `
Build a final skill.md for this author profile.
Rules:
- ${languageInstruction}
- Keep markdown concise and precise.
- Do not add unsupported facts.
- Keep sections: frontmatter, title, PART A, PART B, execution rules.

Slug: ${slug}
Name: ${name}

Knowledge section draft:
${knowledgeMarkdown}

Persona section draft:
${personaMarkdown}
`;
}

export function analyzeCorpus(items, options = {}) {
  const stats = collectCorpusStats(items);
  const requestedLanguage = normalizeLanguage(options.language);
  const resolvedLanguage =
    requestedLanguage === "auto" ? detectLanguageFromItems(items) : requestedLanguage;

  const knowledgeAnalysis = analyzeKnowledge(items, stats, resolvedLanguage);
  const personaAnalysis = analyzePersona(items, resolvedLanguage);

  return {
    knowledgeAnalysis,
    personaAnalysis,
    metadata: {
      itemCount: items.length,
      language: resolvedLanguage,
      generatedAt: new Date().toISOString()
    }
  };
}

export async function buildProfileArtifacts(payload) {
  const { slug, name, items, options = {}, corrections = [] } = payload;
  const analysis = analyzeCorpus(items, options);
  const modeRequested = options.mode === "ai" ? "ai" : "parser";
  const aiEnabled = Boolean(process.env.OPENAI_API_KEY);
  const modeUsed = modeRequested === "ai" && aiEnabled ? "ai" : "parser";

  const knowledgeMarkdown = buildKnowledgeMarkdown(
    analysis.knowledgeAnalysis,
    analysis.metadata.language
  );
  const personaMarkdown = buildPersonaMarkdown(
    analysis.personaAnalysis,
    analysis.metadata.language
  );

  let skillMarkdown = buildSkillMarkdown({
    slug,
    name,
    language: analysis.metadata.language,
    knowledgeType: "WordPress knowledge profile",
    primaryTopics: analysis.knowledgeAnalysis.coreTopics.slice(0, 3),
    optionalIdentity: "",
    descriptionParts: [
      name,
      analysis.knowledgeAnalysis.coreTopics[0] ?? "general knowledge",
      analysis.personaAnalysis.voice.tone
    ],
    knowledgeMarkdown,
    personaMarkdown
  });

  let aiUsed = false;
  if (modeUsed === "ai") {
    try {
      const prompt = buildAiPrompt({
        slug,
        name,
        knowledgeMarkdown,
        personaMarkdown,
        language: analysis.metadata.language
      });
      const aiSkill = await callModel(prompt);
      if (aiSkill) {
        skillMarkdown = aiSkill;
        aiUsed = true;
      }
    } catch {
      aiUsed = false;
    }
  }

  const rag = buildRagChunks(items).map((chunk) => ({
    ...chunk,
    metadata: {
      ...chunk.metadata,
      slug,
      topic_hint: analysis.knowledgeAnalysis.coreTopics[0] ?? null
    }
  }));

  const meta = {
    name,
    slug,
    language: analysis.metadata.language,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    version: "v1",
    mode: modeUsed,
    source_types: options.sourceTypes ?? ["wordpress_json_or_url"],
    source_count: items.length,
    ai_enabled: aiEnabled,
    ai_used: aiUsed,
    knowledge_topics: analysis.knowledgeAnalysis.coreTopics.slice(0, 10),
    tags: {
      tone: [analysis.personaAnalysis.voice.tone, analysis.personaAnalysis.voice.pace],
      format: [
        analysis.personaAnalysis.formatting.prefersStructuredLists
          ? "structured-lists"
          : "narrative",
        "concise-first"
      ]
    },
    corrections_count: corrections.length
  };

  return {
    meta,
    knowledgeAnalysis: analysis.knowledgeAnalysis,
    personaAnalysis: analysis.personaAnalysis,
    knowledgeMarkdown,
    personaMarkdown,
    skillMarkdown,
    rag,
    metadata: {
      modeRequested,
      modeUsed,
      aiUsed,
      itemCount: items.length,
      generatedAt: new Date().toISOString()
    }
  };
}

// Backward-compatible endpoint behavior.
export async function generateArtifacts(items, options = {}) {
  const slug = options.slug || "author-profile";
  const name = options.name || "Author";
  return buildProfileArtifacts({
    slug,
    name,
    items,
    options
  });
}
