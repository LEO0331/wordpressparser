# PRD: WordPress Author Skill Pipeline

## Goal

Generate reusable `skill.md` artifacts from WordPress data to build personal tone, characteristics, and knowledge base profiles.

## Scope

- Input: WordPress URL, WordPress JSON, pasted text
- Language: English and Traditional Chinese only
- Output: `skill.md` (primary), `knowledge.md`, `persona.md`, `rag.json`, `meta.json`
- Persistent profiles under `profiles/{slug}/`
- Incremental update and rollback

## Pipeline

1. Collect source data
2. Normalize entries
3. Analyze knowledge track
4. Analyze persona track
5. Build markdown artifacts
6. Save profile + snapshot version

## Modes

- `ai`: requires `OPENAI_API_KEY`
- `parser`: deterministic fallback when no API key is set

## API

- `POST /api/normalize`
- `POST /api/extract-url`
- `POST /api/analyze`
- `POST /api/build`
- `POST /api/profiles/save`
- `GET /api/profiles`
- `GET /api/profiles/:slug`
- `POST /api/profiles/:slug/update`
- `POST /api/profiles/:slug/correct`
- `POST /api/profiles/:slug/rollback`
