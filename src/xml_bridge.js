import { XMLParser } from "fast-xml-parser";
import { buildZipBuffer } from "./zip_writer.js";

const XML_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: true,
  parseTagValue: false,
  textNodeName: "#text"
};

function createCodedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function slugify(value = "") {
  const base = String(value).toLowerCase().trim();
  const cleaned = base
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "untitled";
}

function decodeHtmlEntities(input) {
  return String(input)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number.parseInt(code, 10)));
}

function sanitizeMarkdownUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("vbscript:") ||
    lower.startsWith("data:")
  ) {
    return "";
  }
  if (
    raw.startsWith("/") ||
    raw.startsWith("./") ||
    raw.startsWith("../") ||
    raw.startsWith("#")
  ) {
    return raw;
  }
  try {
    const parsed = new URL(raw);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === "http:" || protocol === "https:" || protocol === "mailto:") {
      return raw;
    }
    return "";
  } catch {
    return "";
  }
}

function toMarkdownLinkTarget(input) {
  const safe = sanitizeMarkdownUrl(input);
  if (!safe) return "";
  return encodeURI(safe).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function stripUnsafeBlocks(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ");
}

function parseAttributes(fragment = "") {
  const attrs = {};
  const pattern = /([a-zA-Z_:][\w:.-]*)\s*=\s*(["'])(.*?)\2/g;
  let match = pattern.exec(fragment);
  while (match) {
    attrs[match[1].toLowerCase()] = decodeHtmlEntities(match[3]);
    match = pattern.exec(fragment);
  }
  return attrs;
}

function flattenText(html) {
  return decodeHtmlEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function htmlToMarkdown(html) {
  const cleaned = stripUnsafeBlocks(String(html || ""));
  const withImages = cleaned.replace(/<img\b([^>]*)>/gi, (_m, attrsRaw) => {
    const attrs = parseAttributes(attrsRaw);
    const src = toMarkdownLinkTarget(attrs.src);
    if (!src) return "";
    const alt = (attrs.alt || "Image").replace(/[\[\]]/g, "");
    return `\n\n![${alt}](${src})\n\n`;
  });

  const withMedia = withImages.replace(/<(iframe|audio|video|source)\b([^>]*)>([\s\S]*?)<\/\1>/gi, (_m, _tag, attrsRaw) => {
    const attrs = parseAttributes(attrsRaw);
    const src = toMarkdownLinkTarget(attrs.src || attrs.href);
    return src ? `\n\n[Embedded media](${src})\n\n` : "\n\n";
  });

  const withLinks = withMedia.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, attrsRaw, inner) => {
    const attrs = parseAttributes(attrsRaw);
    const href = toMarkdownLinkTarget(attrs.href);
    const label = flattenText(inner).replace(/[\n\r]+/g, " ").trim() || "Link";
    if (!href) return label;
    return `[${label}](${href})`;
  });

  const withLists = withLinks
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(ul|ol)>/gi, "\n")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, inner) => {
      const hashes = "#".repeat(Number(level));
      return `\n\n${hashes} ${flattenText(inner)}\n\n`;
    });

  return flattenText(withLists);
}

function yamlQuote(value) {
  if (value == null) return "null";
  const raw = String(value)
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `"${raw}"`;
}

function renderFrontmatter(meta) {
  const lines = [
    "---",
    `title: ${yamlQuote(meta.title)}`,
    `slug: ${yamlQuote(meta.slug)}`,
    `date: ${yamlQuote(meta.date || "")}`,
    `updated: ${yamlQuote(meta.updated || "")}`,
    `status: ${yamlQuote(meta.status || "")}`,
    `type: ${yamlQuote(meta.type || "")}`,
    "categories:",
    ...meta.categories.map((x) => `  - ${yamlQuote(x)}`),
    "tags:",
    ...meta.tags.map((x) => `  - ${yamlQuote(x)}`),
    `source_url: ${yamlQuote(meta.source_url || "")}`,
    `wordpress_id: ${yamlQuote(meta.wordpress_id || "")}`,
    "---"
  ];
  return lines.join("\n");
}

function normalizeCategoryNodes(rawCategory) {
  const values = toArray(rawCategory);
  const categories = [];
  const tags = [];

  for (const node of values) {
    if (typeof node === "string") {
      categories.push(node.trim());
      continue;
    }
    const domain = String(node?.domain || "").toLowerCase();
    const value = String(node?.["#text"] || node?.text || "").trim();
    if (!value) continue;
    if (domain === "post_tag" || domain === "tag") {
      tags.push(value);
    } else {
      categories.push(value);
    }
  }

  return {
    categories: [...new Set(categories)],
    tags: [...new Set(tags)]
  };
}

function normalizeWxrItem(item) {
  const title = decodeHtmlEntities(String(item?.title || "").trim()) || "Untitled";
  const type = String(item?.["wp:post_type"] || "").trim();
  const status = String(item?.["wp:status"] || "").trim();
  const date = String(item?.["wp:post_date_gmt"] || item?.["wp:post_date"] || item?.pubDate || "").trim();
  const updated = String(item?.["wp:post_modified_gmt"] || item?.["wp:post_modified"] || "").trim();
  const slug = String(item?.["wp:post_name"] || "").trim() || slugify(title);
  const sourceUrl = sanitizeMarkdownUrl(String(item?.link || item?.guid?.["#text"] || item?.guid || "").trim());
  const wordpressId = String(item?.["wp:post_id"] || "").trim();
  const htmlContent = item?.["content:encoded"] || item?.description || "";
  const markdownContent = htmlToMarkdown(htmlContent);
  const { categories, tags } = normalizeCategoryNodes(item?.category);

  return {
    title,
    slug,
    date,
    updated,
    status,
    type,
    source_url: sourceUrl,
    wordpress_id: wordpressId,
    categories,
    tags,
    content: markdownContent,
    url: sourceUrl
  };
}

export function parseWordPressXml(xmlText) {
  let parsed;
  try {
    parsed = new XMLParser(XML_OPTIONS).parse(String(xmlText));
  } catch {
    throw createCodedError("The uploaded file is not valid WordPress XML.", "invalid_xml");
  }

  if (!parsed?.rss?.channel) {
    throw createCodedError(
      "The uploaded file is not a valid WordPress WXR XML export.",
      "invalid_xml"
    );
  }

  const items = toArray(parsed?.rss?.channel?.item);
  if (!items.length) {
    throw createCodedError("No posts/pages were found in this XML export.", "empty_export");
  }

  return items.map((item) => normalizeWxrItem(item));
}

function buildMarkdownFilename(item, fallbackIndex) {
  const prefix = item.date ? item.date.slice(0, 10) : `item-${fallbackIndex + 1}`;
  const safePrefix = prefix.replace(/[^\d-]/g, "");
  return `${safePrefix || `item-${fallbackIndex + 1}`}-${slugify(item.slug || item.title || `${fallbackIndex + 1}`)}.md`;
}

export function buildObsidianMarkdown(item) {
  const frontmatter = renderFrontmatter(item);
  return `${frontmatter}\n\n${item.content}\n`;
}

export function convertWordPressXmlToObsidian(xmlText) {
  const normalized = parseWordPressXml(xmlText);
  const files = [];
  const warnings = [];
  let skippedCount = 0;

  for (let i = 0; i < normalized.length; i += 1) {
    const item = normalized[i];
    if (item.type !== "post" && item.type !== "page") {
      skippedCount += 1;
      warnings.push(`Skipped item ${i + 1}: unsupported post type '${item.type || "unknown"}'.`);
      continue;
    }
    if (!item.content) {
      skippedCount += 1;
      warnings.push(`Skipped '${item.title}': empty content after sanitization.`);
      continue;
    }
    if (!item.title || item.title === "Untitled") {
      warnings.push(`Item ${i + 1} missing title; using fallback title.`);
    }
    if (!item.date) {
      warnings.push(`'${item.title}' missing date metadata.`);
    }
    files.push({
      name: buildMarkdownFilename(item, i),
      content: buildObsidianMarkdown(item)
    });
  }

  if (!files.length) {
    throw createCodedError(
      "No supported post/page entries could be converted.",
      "unsupported_format"
    );
  }

  return {
    zipBuffer: buildZipBuffer(files),
    metadata: {
      totalItems: normalized.length,
      convertedItems: files.length,
      skippedItems: skippedCount,
      warningCount: warnings.length,
      warnings
    }
  };
}

export function parseMultipartXmlUpload(bodyBuffer, contentTypeHeader = "") {
  if (!Buffer.isBuffer(bodyBuffer) || bodyBuffer.length === 0) {
    throw createCodedError("Missing XML upload payload.", "unsupported_format");
  }

  const boundaryMatch = String(contentTypeHeader).match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary) {
    throw createCodedError(
      "Unsupported upload format. Please upload as multipart/form-data.",
      "unsupported_format"
    );
  }

  const parts = bodyBuffer.toString("utf8").split(`--${boundary}`);
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part || part === "--") continue;
    const [headerText, ...contentParts] = part.split("\r\n\r\n");
    if (!headerText || !contentParts.length) continue;
    const disposition = headerText.match(/content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]+)")?/i);
    if (!disposition) continue;
    const fieldName = disposition[1];
    const filename = disposition[2] || "";
    if (fieldName !== "file") continue;

    const content = contentParts.join("\r\n\r\n").replace(/\r\n$/, "");
    if (!filename.toLowerCase().endsWith(".xml")) {
      throw createCodedError(
        "Unsupported file type. Please upload a .xml export file.",
        "unsupported_format"
      );
    }
    if (!content.trim()) {
      throw createCodedError("Uploaded XML file is empty.", "empty_export");
    }
    return content;
  }

  throw createCodedError("Missing 'file' field in upload payload.", "unsupported_format");
}
