import test from "node:test";
import assert from "node:assert/strict";
import { buildRagChunks, collectCorpusStats, normalizeWordPressData, stripHtml } from "../src/parser.js";

test("stripHtml removes tags and decodes entities", () => {
  const out = stripHtml("<p>Hello&nbsp;<strong>World</strong> &amp; friends</p>");
  assert.equal(out, "Hello World & friends");
});

test("normalizeWordPressData supports wordpress.com shape and taxonomy objects", () => {
  const data = {
    posts: [
      {
        title: "Older",
        content: "<p>alpha content</p>",
        date: "2026-01-01",
        URL: "https://example.com/older",
        categories: { a: { name: "Investing" } },
        tags: { t1: { slug: "strategy" } }
      },
      {
        title: { rendered: "Newer" },
        content: { rendered: "<p>beta content</p>" },
        date: "2026-02-01",
        guid: { rendered: "https://example.com/newer" },
        categories: ["Macro"],
        tags: []
      }
    ]
  };

  const out = normalizeWordPressData(data);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, "Newer");
  assert.equal(out[1].categories[0], "Investing");
  assert.equal(out[1].tags[0], "strategy");
});

test("collectCorpusStats returns expected aggregates", () => {
  const items = [
    { content: "Alpha alpha beta.", date: "2026-01-01" },
    { content: "Beta gamma.", date: "2026-02-01" }
  ];
  const stats = collectCorpusStats(items);
  assert.equal(stats.count, 2);
  assert.ok(stats.avgChars > 0);
  assert.ok(stats.minDate.includes("2026-01-01"));
  assert.ok(stats.maxDate.includes("2026-02-01"));
  assert.ok(stats.topKeywords.some((x) => x.word === "alpha"));
});

test("buildRagChunks chunks content with overlap metadata", () => {
  const items = [
    {
      title: "Chunk Title",
      date: "2026-01-01",
      url: "https://example.com",
      content: "a".repeat(1400)
    }
  ];
  const chunks = buildRagChunks(items, 800, 100);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].metadata.title, "Chunk Title");
  assert.ok(chunks[1].text.length > 0);
});
