import test from "node:test";
import assert from "node:assert/strict";
import { markdownToHtml, normalizePostFromMarkdown, parseMarkdownDocument } from "../mcp/markdown.js";

test("parseMarkdownDocument reads frontmatter and body", () => {
  const input = `---\ntitle: Sample\ncategories: [1,2]\n---\n\n# Hello\n\nBody`;
  const out = parseMarkdownDocument(input);
  assert.equal(out.frontmatter.title, "Sample");
  assert.deepEqual(out.frontmatter.categories, [1, 2]);
  assert.ok(out.body.includes("# Hello"));
});

test("normalizePostFromMarkdown validates title and converts categories/tags", () => {
  const input = `---\ntitle: Draft title\ncategories: [10, "x", 30]\ntags: 4, 9\nstatus: draft\n---\n\nhello **world**`;
  const out = normalizePostFromMarkdown(input);
  assert.equal(out.title, "Draft title");
  assert.deepEqual(out.categories, [10, 30]);
  assert.deepEqual(out.tags, [4, 9]);
  assert.equal(out.status, "draft");
  assert.ok(out.contentHtml.includes("<strong>world</strong>"));
});

test("markdownToHtml supports heading and bullet list", () => {
  const html = markdownToHtml("# Title\n\n- one\n- two");
  assert.ok(html.includes("<h1>Title</h1>"));
  assert.ok(html.includes("<ul><li>one</li><li>two</li></ul>"));
});
