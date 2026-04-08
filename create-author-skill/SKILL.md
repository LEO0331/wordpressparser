---
name: create-author-skill
description: "Distill a WordPress author into an AI Skill with URL/JSON collection, knowledge+persona extraction, and incremental evolution. | 将 WordPress 作者蒸馏成 AI Skill，支持 URL/JSON 采集、知识+人格抽取、持续进化。"
argument-hint: "[author-name-or-slug]"
version: "1.0.0"
user-invocable: true
allowed-tools: Read, Write, Edit, Bash
---

> Language: English and Traditional Chinese only.
> Respond in the user's first-message language when possible.

# Author Skill Creator

## Trigger

- `/create-author-skill`
- "generate skill.md from this WordPress"
- "make an author skill"
- "蒸馏这个 WordPress 成 skill"

## Main Flow

1. Intake: collect `slug`, display name, and optional profile hints.
2. Import source material from WordPress URL / JSON file / pasted text.
3. Normalize and analyze in two tracks:
   - Knowledge analyzer
   - Persona analyzer
4. Build `knowledge.md` and `persona.md`.
5. Merge into final `skill.md`.
6. Save into `profiles/{slug}/` and version snapshots under `profiles/{slug}/versions/`.

## Runtime Guardrails

1. PART A is for factual knowledge and source-grounded claims.
2. PART B is for tone and writing style.
3. If evidence is weak, explicitly mark uncertainty.
4. Output language must be English or Traditional Chinese.
