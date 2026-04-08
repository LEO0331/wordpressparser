# Knowledge Analyzer Prompt

Goal: extract reusable domain knowledge from normalized WordPress entries.

Priorities:
- core topics
- canonical claims
- domain terms
- evidence-linked references

Rules:
- no fabricated facts
- only English or Traditional Chinese output
- prefer explicit claims from source text

Output JSON:

```json
{
  "core_topics": [],
  "canonical_claims": [],
  "domain_terms": [],
  "evidence_posts": []
}
```
