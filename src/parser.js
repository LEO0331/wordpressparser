const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with", "is", "are",
  "was", "were", "be", "been", "as", "at", "by", "from", "that", "this", "it", "its", "you",
  "your", "i", "we", "they", "their", "our", "my", "me", "he", "she", "his", "her", "them",
  "if", "then", "than", "so", "not", "no", "yes", "can", "could", "should", "would", "will",
  "just", "about", "into", "over", "after", "before", "also", "too", "very", "more", "most"
]);

const HTML_ENTITIES = new Map([
  ["&nbsp;", " "],
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", "\""],
  ["&#39;", "'"]
]);

function decodeEntities(input) {
  let out = input;
  for (const [entity, value] of HTML_ENTITIES.entries()) {
    out = out.split(entity).join(value);
  }
  out = out.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
  return out;
}

export function stripHtml(input = "") {
  if (!input) return "";
  const withoutScripts = input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const plain = withoutScripts
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(plain).replace(/\s+/g, " ").trim();
}

function pickContent(raw) {
  return (
    raw?.content?.rendered ??
    raw?.content ??
    raw?.post_content ??
    raw?.excerpt?.rendered ??
    raw?.description ??
    ""
  );
}

function pickTitle(raw) {
  return (
    raw?.title?.rendered ??
    raw?.title ??
    raw?.post_title ??
    raw?.name ??
    "Untitled"
  );
}

function pickDate(raw) {
  return raw?.date ?? raw?.post_date ?? raw?.pubDate ?? raw?.published ?? null;
}

function pickUrl(raw) {
  if (typeof raw?.guid === "string") return raw.guid;
  if (raw?.guid?.rendered) return raw.guid.rendered;
  return raw?.URL ?? raw?.link ?? raw?.url ?? null;
}

function normalizeTaxonomy(taxonomyValue) {
  if (!taxonomyValue) return [];
  if (Array.isArray(taxonomyValue)) return taxonomyValue;
  if (typeof taxonomyValue === "object") {
    return Object.values(taxonomyValue)
      .map((item) => item?.name ?? item?.slug ?? null)
      .filter(Boolean);
  }
  return [];
}

function pickItemsCandidate(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];

  const candidates = [
    data.posts,
    data.pages,
    data.items,
    data.entries,
    data.channel?.item,
    data.feed?.entries,
    data.wp_posts
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  // Some exporters nest in { data: [...] }.
  if (Array.isArray(data.data)) return data.data;
  return [];
}

export function normalizeWordPressData(data) {
  const rawItems = pickItemsCandidate(data);
  const normalized = [];

  for (const raw of rawItems) {
    const content = stripHtml(pickContent(raw));
    if (!content) continue;

    normalized.push({
      title: stripHtml(pickTitle(raw)),
      content,
      date: pickDate(raw),
      url: pickUrl(raw),
      categories: normalizeTaxonomy(raw?.categories ?? raw?.category),
      tags: normalizeTaxonomy(raw?.tags)
    });
  }

  normalized.sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return db - da;
  });

  return normalized;
}

export function collectCorpusStats(items) {
  if (!items.length) {
    return {
      count: 0,
      avgChars: 0,
      minDate: null,
      maxDate: null,
      topKeywords: []
    };
  }

  let totalChars = 0;
  const dates = [];
  const freq = new Map();

  for (const item of items) {
    totalChars += item.content.length;
    if (item.date) {
      const t = new Date(item.date).getTime();
      if (!Number.isNaN(t)) dates.push(t);
    }

    const words = item.content.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [];
    for (const word of words) {
      if (STOPWORDS.has(word)) continue;
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
  }

  const topKeywords = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([word, count]) => ({ word, count }));

  return {
    count: items.length,
    avgChars: Math.round(totalChars / items.length),
    minDate: dates.length ? new Date(Math.min(...dates)).toISOString() : null,
    maxDate: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
    topKeywords
  };
}

export function buildRagChunks(items, chunkSize = 1200, overlap = 200) {
  // Legacy helper kept for backward compatibility with older tests and profiles.
  const chunks = [];
  let idx = 0;

  for (const item of items) {
    const text = item.content;
    if (!text) continue;
    let cursor = 0;
    while (cursor < text.length) {
      const end = Math.min(cursor + chunkSize, text.length);
      const chunkText = text.slice(cursor, end).trim();
      if (chunkText) {
        chunks.push({
          id: `chunk_${idx++}`,
          text: chunkText,
          metadata: {
            title: item.title,
            date: item.date,
            url: item.url
          }
        });
      }
      if (end >= text.length) break;
      cursor = Math.max(end - overlap, cursor + 1);
    }
  }

  return chunks;
}
