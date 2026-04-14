import { assertConfigured } from "./config.js";

export const TOOL_DEFINITIONS = [
  {
    name: "list_wp_posts",
    description:
      "List WordPress posts so AI can pick an id before reading full content. Call this before read_wp_post.",
    inputSchema: {
      type: "object",
      properties: {
        per_page: { type: "integer", minimum: 1, maximum: 100, default: 10 },
        page: { type: "integer", minimum: 1, default: 1 },
        status: {
          oneOf: [
            { type: "string", description: "Comma-separated statuses, e.g. publish,draft" },
            {
              type: "array",
              items: { type: "string" },
              description: "Status list, e.g. [\"publish\",\"draft\"]"
            }
          ]
        },
        search: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "read_wp_post",
    description: "Read one WordPress post by id and return title/content text/html.",
    inputSchema: {
      type: "object",
      properties: {
        post_id: { type: "integer", minimum: 1 }
      },
      required: ["post_id"],
      additionalProperties: false
    }
  },
  {
    name: "create_wp_draft_from_markdown",
    description:
      "Create a WordPress draft from Markdown with frontmatter. Supported frontmatter keys: title, status, slug, excerpt, categories, tags.",
    inputSchema: {
      type: "object",
      properties: {
        markdown_doc: { type: "string", minLength: 1 }
      },
      required: ["markdown_doc"],
      additionalProperties: false
    }
  },
  {
    name: "update_wp_draft_from_markdown",
    description:
      "Update an existing draft from Markdown with frontmatter. Refuses updates when post is not in draft status.",
    inputSchema: {
      type: "object",
      properties: {
        post_id: { type: "integer", minimum: 1 },
        markdown_doc: { type: "string", minLength: 1 }
      },
      required: ["post_id", "markdown_doc"],
      additionalProperties: false
    }
  },
  {
    name: "publish_wp_post",
    description:
      "Publish an existing post by id. Safety gate: confirm must be true.",
    inputSchema: {
      type: "object",
      properties: {
        post_id: { type: "integer", minimum: 1 },
        confirm: { type: "boolean" }
      },
      required: ["post_id", "confirm"],
      additionalProperties: false
    }
  }
];

function asText(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function toToolResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: asText(payload)
      }
    ],
    structuredContent: typeof payload === "string" ? { message: payload } : payload
  };
}

export async function executeTool(name, args, { client, config }) {
  assertConfigured(config);

  switch (name) {
    case "list_wp_posts": {
      const result = await client.listPosts(args || {});
      return toToolResult(result);
    }
    case "read_wp_post": {
      const result = await client.readPost(args?.post_id);
      return toToolResult(result);
    }
    case "create_wp_draft_from_markdown": {
      const result = await client.createDraftFromMarkdown(args?.markdown_doc);
      return toToolResult(result);
    }
    case "update_wp_draft_from_markdown": {
      const result = await client.updateDraftFromMarkdown(args?.post_id, args?.markdown_doc);
      return toToolResult(result);
    }
    case "publish_wp_post": {
      const result = await client.publishPost(args?.post_id, args?.confirm);
      return toToolResult(result);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
