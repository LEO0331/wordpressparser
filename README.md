# WordPress Author Skill Pipeline

Node-first pipeline that turns WordPress sources into a reusable `skill.md`.

## What it does

- Ingests WordPress JSON, URL, or pasted JSON in the UI
- Normalizes posts/pages into a corpus
- Analyzes two tracks:
  - Knowledge
  - Persona (writing tone/style)
- Builds artifacts:
  - `skill.md` (primary)
  - `knowledge.md`
  - `persona.md`
  - `wiki.md`
  - `meta.json`
- Stores profiles under `profiles/{slug}/` with version snapshots

## Language support

- English (`en`)
- Traditional Chinese (`zh-TW`)

## Generation modes

- `ai` mode: uses `OPENAI_API_KEY` and model generation
- `parser` mode: deterministic fallback when no API key is present

If `OPENAI_API_KEY` is missing, the system automatically falls back to parser mode.

## Quick start

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Environment

- `OPENAI_API_KEY` (optional)
- `OPENAI_MODEL` (optional, default `gpt-4.1-mini`)
- `PORT` (optional, default `3000`)
- `BLOB_READ_WRITE_TOKEN` (optional, required for persistent storage on Vercel)
- `WP_BASE_URL`, `WP_USERNAME`, `WP_APP_PASSWORD` (optional, for MCP sidecar)
- `WP_API_VERSION` (optional, default `v2`, for MCP sidecar)

Storage behavior:
- If `BLOB_READ_WRITE_TOKEN` is present, profile data is saved to Vercel Blob.
- Otherwise, profile data is saved to local filesystem under `profiles/{slug}/`.

## Vercel deployment

This repo includes [vercel.json](./vercel.json) tuned for Express.

Recommended project settings:
- Framework Preset: Other
- Root Directory: repository root
- Production Branch: `main`
- Environment Variables:
  - `OPENAI_API_KEY` (optional)
  - `OPENAI_MODEL` (optional)
  - `BLOB_READ_WRITE_TOKEN` (required if you use profile save/update/rollback in production)

## API

- `POST /api/normalize`
  - body: `{ "data": <wordpress_json> }`
- `POST /api/extract-url`
  - body: `{ "url": "https://example.wordpress.com/" }`
- `POST /api/analyze`
  - body: `{ "items": [...], "options": { "language": "en|zh-TW|auto", "mode": "parser|ai" } }`
- `POST /api/build`
  - body: `{ "slug": "x", "name": "X", "items": [...], "options": { ... } }`
- `POST /api/profiles/save`
  - body: same as build, persists artifacts under `profiles/{slug}/`
- `GET /api/profiles`
- `GET /api/profiles/:slug`
- `POST /api/profiles/:slug/update`
  - body: `{ "items": [...], "options": { ... } }`
- `POST /api/profiles/:slug/correct`
  - body: `{ "scope": "knowledge|persona", "correction": "..." }`
- `POST /api/profiles/:slug/rollback`
  - body: `{ "version": "vN-....json" }`

## Node utilities

- `node node_tools/version_manager.js backup <slug>`
- `node node_tools/version_manager.js list <slug>`
- `node node_tools/version_manager.js rollback <slug> <version>`
- `node node_tools/skill_writer.js <slug>`

## WordPress MCP sidecar

You can run an independent MCP server without affecting existing API/deployment:

```bash
npm run mcp:wp
```

See setup and tool docs in `docs/mcp-wordpress.md`.

## Reference design assets

`create-author-skill/` contains skill and prompt templates aligned with this pipeline design.

## CI/CD

GitHub Actions pipeline is included at [ci.yml](./.github/workflows/ci.yml):
- install dependencies
- run static check
- boot server
- run API smoke test (`npm run test:smoke`)
