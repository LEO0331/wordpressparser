# WordPress Persona Parser

Simple full-stack webpage that:
- accepts WordPress JSON exports or a WordPress URL,
- supports pasted raw JSON directly in the UI,
- normalizes post/page content,
- generates a reusable `skill.md` with preset schemas,
- optionally exports `rag.json` chunks for retrieval systems.

## Quick start

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Environment

Set `OPENAI_API_KEY` to enable built-in AI generation.

Optional:
- `OPENAI_MODEL` (default: `gpt-4.1-mini`)
- `PORT` (default: `3000`)

Without an API key, the app still generates a deterministic fallback `skill.md`.

## API endpoints

- `POST /api/normalize` with `{ "data": <wordpress_json_object> }`
- `POST /api/extract-url` with `{ "url": "https://example.wordpress.com/" }`
- `POST /api/generate` with `{ "items": [...], "options": { "language": "auto|English|Traditional Chinese", "preset": "default|codex_skill|rag_profile" } }`

## Notes

- URL import tries `wp-json/wp/v2/posts|pages` first, then WordPress.com official REST v1.1 (`public-api.wordpress.com/rest/v1.1/sites/<host>/posts`) including `type=post|page`.
- RAG chunks use 1200-char chunks with 200-char overlap and metadata (`title`, `date`, `url`).
- Parser supports WordPress.com v1.1 sample payloads (`found`, `posts`, uppercase `URL`, taxonomy objects).
