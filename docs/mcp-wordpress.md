# WordPress MCP Sidecar (Node.js)

This project includes a standalone MCP server at `mcp/server.js`.
It is a sidecar process and does not change existing web API routes or Vercel deployment behavior.

## Environment variables

- `WP_BASE_URL` (required), e.g. `https://your-site.com`
- `WP_USERNAME` (required)
- `WP_APP_PASSWORD` (required, WordPress Application Password)
- `WP_API_VERSION` (optional, default: `v2`)
- `WP_TIMEOUT_MS` (optional, default: `15000`)
- `WP_ALLOW_INSECURE_HTTP` (optional, default: `false`; only for local testing)
- `MCP_MAX_MESSAGE_BYTES` (optional, default: `1048576`)

## Run locally

```bash
npm run mcp:wp
```

## Supported tools

- `list_wp_posts`
- `read_wp_post`
- `create_wp_draft_from_markdown`
- `update_wp_draft_from_markdown`
- `publish_wp_post` (requires `confirm=true`)

## Version behavior

- Uses `WP_API_VERSION` as preferred version.
- If preferred version is unavailable, server auto-falls back to a working version and includes warning text.
- Current implementation supports `v2` directly and reserves `v3` mapping for future extension.

## MCP client config example

```json
{
  "mcpServers": {
    "wordpress-sidecar": {
      "command": "node",
      "args": ["/absolute/path/to/wordpressparser/mcp/server.js"],
      "env": {
        "WP_BASE_URL": "https://your-site.com",
        "WP_USERNAME": "your-username",
        "WP_APP_PASSWORD": "xxxx xxxx xxxx xxxx xxxx xxxx",
        "WP_API_VERSION": "v2",
        "WP_TIMEOUT_MS": "15000"
      }
    }
  }
}
```

## Markdown frontmatter format

`create_wp_draft_from_markdown` and `update_wp_draft_from_markdown` expect:

```md
---
title: My Draft
status: draft
slug: my-draft
excerpt: short summary
categories: [12, 34]
tags: [56, 78]
---

# Heading

Your markdown body here.
```

Notes:
- `title` is required.
- `categories` and `tags` are integer ID arrays in v1.
- If frontmatter status is `publish` in draft creation, it is forced to `draft` with warning.
- HTTPS is required by default. To allow `http://` in local-only environments, set `WP_ALLOW_INSECURE_HTTP=true`.
