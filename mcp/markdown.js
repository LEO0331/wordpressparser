const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

function parseArrayValue(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return null;
    }
  }
  if (trimmed.includes(",")) {
    return trimmed
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return null;
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatter(raw) {
  const meta = {};
  const lines = raw.split("\n");

  for (const line of lines) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const idx = text.indexOf(":");
    if (idx < 0) continue;

    const key = text.slice(0, idx).trim();
    const value = text.slice(idx + 1).trim();
    if (!key) continue;

    const arr = parseArrayValue(value);
    meta[key] = arr ?? parseScalar(value);
  }

  return meta;
}

function toIntegerArray(value) {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .map((x) => Number(x))
    .filter((x) => Number.isInteger(x) && x > 0);
}

function escapeHtml(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function convertInline(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

function renderBlock(block) {
  const lines = block.split("\n");
  if (!lines.length) return "";

  const listItems = [];
  let isList = true;
  for (const line of lines) {
    const m = line.match(/^[-*]\s+(.+)$/);
    if (!m) {
      isList = false;
      break;
    }
    listItems.push(`<li>${convertInline(m[1])}</li>`);
  }
  if (isList) return `<ul>${listItems.join("")}</ul>`;

  if (lines.length === 1) {
    const line = lines[0];
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      return `<h${level}>${convertInline(heading[2])}</h${level}>`;
    }
  }

  const content = lines.map((x) => convertInline(x)).join("<br />");
  return `<p>${content}</p>`;
}

export function markdownToHtml(markdown) {
  const source = String(markdown || "").replace(/\r\n/g, "\n").trim();
  if (!source) return "";
  const blocks = source.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
  return blocks.map(renderBlock).join("\n");
}

export function parseMarkdownDocument(markdownDoc) {
  const raw = String(markdownDoc || "").replace(/\r\n/g, "\n");
  let frontmatter = {};
  let body = raw;

  const match = raw.match(FRONTMATTER_RE);
  if (match) {
    frontmatter = parseFrontmatter(match[1]);
    body = raw.slice(match[0].length);
  }

  return {
    frontmatter,
    body: body.trim()
  };
}

export function normalizePostFromMarkdown(markdownDoc) {
  const { frontmatter, body } = parseMarkdownDocument(markdownDoc);
  const title = String(frontmatter.title || "").trim();
  if (!title) throw new Error("Frontmatter requires a non-empty title.");
  if (!body) throw new Error("Markdown body is empty.");

  const status = String(frontmatter.status || "draft").trim().toLowerCase();
  const normalizedStatus = ["draft", "pending", "private", "publish"].includes(status)
    ? status
    : "draft";

  return {
    title,
    status: normalizedStatus,
    slug: frontmatter.slug ? String(frontmatter.slug).trim() : undefined,
    excerpt: frontmatter.excerpt ? String(frontmatter.excerpt).trim() : undefined,
    categories: toIntegerArray(frontmatter.categories),
    tags: toIntegerArray(frontmatter.tags),
    contentMarkdown: body,
    contentHtml: markdownToHtml(body)
  };
}
