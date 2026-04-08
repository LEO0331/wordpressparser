# Persona Analyzer Prompt

Goal: extract writing persona from normalized WordPress entries.

Priorities:
- tone
- pacing
- structure preference
- confidence level
- rhetorical patterns

Rules:
- do not infer interpersonal behavior unless source supports it
- no fabricated biography
- language constrained to English or Traditional Chinese

Output JSON:

```json
{
  "voice": {},
  "formatting": {},
  "reasoning_patterns": [],
  "guardrails": []
}
```
