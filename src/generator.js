import { buildRagChunks, collectCorpusStats } from "./parser.js";

const PRESET_DEFS = {
  default: {
    name: "General Skill",
    description: "Balanced tone + knowledge profile for broad AI usage.",
    sections: [
      "# Author Profile",
      "## Core Voice",
      "## Writing Patterns",
      "## Topic Expertise",
      "## Canonical Facts and Preferences",
      "## Prompting Guardrails",
      "## Response Examples"
    ]
  },
  codex_skill: {
    name: "Codex Skill",
    description: "Strict format optimized for coding-assistant skill ingestion.",
    sections: [
      "# SKILL: Author Persona",
      "## Trigger Conditions",
      "## Output Contract",
      "## Tone Rules",
      "## Knowledge Priorities",
      "## Do / Avoid",
      "## Canonical Phrases",
      "## Sample Responses"
    ]
  },
  rag_profile: {
    name: "RAG Profile",
    description: "Strict profile optimized for retrieval + grounded synthesis.",
    sections: [
      "# Profile Card",
      "## Retrieval Priorities",
      "## Topic Map",
      "## Evidence-Bound Claims",
      "## Answer Style",
      "## Safety and Uncertainty Policy",
      "## Query Routing Hints"
    ]
  }
};

function resolvePreset(presetId) {
  return PRESET_DEFS[presetId] ?? PRESET_DEFS.default;
}

function selectSamples(items, maxCount = 12, maxCharsEach = 900) {
  const candidates = [...items]
    .sort((a, b) => b.content.length - a.content.length)
    .slice(0, maxCount);

  return candidates.map((item, i) => ({
    id: i + 1,
    title: item.title,
    date: item.date,
    text: item.content.slice(0, maxCharsEach)
  }));
}

function buildPrompt({ items, language = "auto", preset = "default" }) {
  const stats = collectCorpusStats(items);
  const samples = selectSamples(items);
  const topicLine = stats.topKeywords.slice(0, 20).map((t) => t.word).join(", ");
  const presetDef = resolvePreset(preset);
  const languageRule =
    language === "auto"
      ? "Write in the same dominant language style found in the source material."
      : `Write in ${language}.`;

  return `
You are creating a reusable skill profile from one person's WordPress writings.

Goal:
- Produce a practical SKILL.md artifact for AI systems to emulate tone, style, and knowledge.
- Keep it concise, structured, and ready to use.
- Follow this strict preset: ${presetDef.name} (${presetDef.description})

Rules:
- ${languageRule}
- Do not fabricate facts. If uncertain, write a cautious note.
- Include examples that are short and representative.
- Output only Markdown.

Required markdown sections in this exact order:
${presetDef.sections.map((s, i) => `${i + 1}) ${s}`).join("\n")}

Corpus stats:
- total_posts: ${stats.count}
- avg_chars: ${stats.avgChars}
- date_range: ${stats.minDate ?? "unknown"} to ${stats.maxDate ?? "unknown"}
- top_keywords: ${topicLine || "unknown"}

Representative excerpts:
${samples
  .map(
    (sample) =>
      `### Sample ${sample.id}\n` +
      `title: ${sample.title}\n` +
      `date: ${sample.date ?? "unknown"}\n` +
      `text: ${sample.text}\n`
  )
  .join("\n")}
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
      temperature: 0.3,
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

function fallbackSkill(items, language = "auto", preset = "default") {
  const stats = collectCorpusStats(items);
  const top = stats.topKeywords.slice(0, 15).map((x) => x.word);
  const sampleTitles = items.slice(0, 6).map((x) => x.title).filter(Boolean);
  const lang = language === "auto" ? "source language" : language;
  const presetDef = resolvePreset(preset);

  if (preset === "codex_skill") {
    return `# SKILL: Author Persona
Derived from ${stats.count} posts in ${lang}.

## Trigger Conditions
- Use when user asks for writing in this author's style or asks domain advice aligned with source topics.

## Output Contract
- Keep responses concise-first, then expand with practical detail.
- Preserve source language dominance unless user asks otherwise.

## Tone Rules
- Reflective but direct, with concrete action points.
- Prefer structured lists and explicit guardrails when discussing decisions.

## Knowledge Priorities
- Focus topics: ${top.join(", ") || "general personal knowledge"}.
- Time range: ${stats.minDate ?? "unknown"} to ${stats.maxDate ?? "unknown"}.

## Do / Avoid
- Do ground claims in source patterns and use cautious wording for uncertain facts.
- Avoid invented credentials, unverifiable numbers, or overconfident claims.

## Canonical Phrases
- "Give the practical version first."
- "Define risk boundaries before optimizing return."

## Sample Responses
- Short: "Start from constraints, then give one recommended path."
- Long: "State principle, show tradeoff, end with concrete next step."
`;
  }

  if (preset === "rag_profile") {
    return `# Profile Card
Corpus size: ${stats.count} posts. Language: ${lang}.

## Retrieval Priorities
- Prefer recent posts first, then high-overlap topic matches.
- Use title/date/url metadata to keep responses grounded.

## Topic Map
- Primary terms: ${top.join(", ") || "general topics"}.

## Evidence-Bound Claims
- Treat extracted chunks as the only source of truth.
- If retrieval confidence is low, ask for clarification or mark uncertainty.

## Answer Style
- Lead with concise conclusion, then evidence-backed explanation.

## Safety and Uncertainty Policy
- Never fabricate biographical or financial facts beyond retrieved evidence.

## Query Routing Hints
- For tone imitation tasks, prioritize high-signal longform posts.
- For factual Q&A, prioritize chunks with explicit numbers and dates.
`;
  }

  return `${presetDef.sections[0]}
Auto-generated fallback profile (${lang}) from ${stats.count} posts.

${presetDef.sections[1]}
- Uses a reflective, personal narrative tone mixed with practical observations.
- Prefers concrete examples over abstract claims.

${presetDef.sections[2]}
- Typical post length is around ${stats.avgChars} characters.
- Often organized around lived experience, then distilled into takeaways.
- Frequent topics include: ${top.join(", ") || "general personal topics"}.

${presetDef.sections[3]}
- Primary knowledge areas are inferred from recurring keywords and post themes.
- Use retrieved chunks for factual grounding before making specific claims.

${presetDef.sections[4]}
- Date range in corpus: ${stats.minDate ?? "unknown"} to ${stats.maxDate ?? "unknown"}.
- Representative post titles: ${sampleTitles.join(" | ") || "n/a"}.

${presetDef.sections[5]}
- Match sentence rhythm and level of directness from source.
- Avoid inventing biographies or credentials not stated in source content.
- Cite uncertainty clearly when context is missing.

${presetDef.sections[6]}
### Short answer style
"Here is the practical version first, then nuance if needed."

### Long answer style
"Start from a personal observation, connect to broader principle, close with actionable takeaway."
`;
}

export async function generateArtifacts(items, options = {}) {
  const language = options.language || "auto";
  const preset = options.preset || "default";
  const prompt = buildPrompt({ items, language, preset });

  let skillMarkdown;
  let aiUsed = false;
  try {
    const modelOutput = await callModel(prompt);
    if (modelOutput) {
      skillMarkdown = modelOutput;
      aiUsed = true;
    } else {
      skillMarkdown = fallbackSkill(items, language, preset);
    }
  } catch (error) {
    skillMarkdown = fallbackSkill(items, language, preset);
  }

  const rag = buildRagChunks(items);
  return {
    skillMarkdown,
    rag,
    metadata: {
      aiUsed,
      preset,
      itemCount: items.length,
      generatedAt: new Date().toISOString()
    }
  };
}
