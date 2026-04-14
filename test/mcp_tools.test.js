import test from "node:test";
import assert from "node:assert/strict";
import { executeTool } from "../mcp/tools.js";

function contextWithClient(overrides = {}) {
  return {
    config: {
      baseUrl: "https://example.com",
      username: "u",
      appPassword: "p"
    },
    client: {
      listPosts: async () => ({ ok: true, type: "list" }),
      readPost: async (id) => ({ ok: true, id }),
      createDraftFromMarkdown: async (doc) => ({ ok: true, doc }),
      updateDraftFromMarkdown: async (id, doc) => ({ ok: true, id, doc }),
      publishPost: async (id, confirm) => ({ ok: true, id, confirm }),
      ...overrides
    }
  };
}

test("executeTool dispatches list and read tools", async () => {
  const ctx = contextWithClient();
  const listed = await executeTool("list_wp_posts", { per_page: 1 }, ctx);
  const read = await executeTool("read_wp_post", { post_id: 99 }, ctx);
  assert.equal(listed.structuredContent.type, "list");
  assert.equal(read.structuredContent.id, 99);
});

test("executeTool dispatches markdown draft/publish tools", async () => {
  const ctx = contextWithClient();
  const created = await executeTool("create_wp_draft_from_markdown", { markdown_doc: "# x" }, ctx);
  const updated = await executeTool(
    "update_wp_draft_from_markdown",
    { post_id: 2, markdown_doc: "# y" },
    ctx
  );
  const published = await executeTool("publish_wp_post", { post_id: 2, confirm: true }, ctx);
  assert.equal(created.structuredContent.doc, "# x");
  assert.equal(updated.structuredContent.id, 2);
  assert.equal(published.structuredContent.confirm, true);
});

test("executeTool rejects unknown tool", async () => {
  await assert.rejects(
    () => executeTool("unknown_tool", {}, contextWithClient()),
    /Unknown tool/
  );
});

test("executeTool rejects when config missing", async () => {
  await assert.rejects(
    () =>
      executeTool("list_wp_posts", {}, {
        config: { baseUrl: "", username: "", appPassword: "" },
        client: {}
      }),
    /Missing WordPress credentials/
  );
});
