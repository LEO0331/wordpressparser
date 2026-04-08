# Correction Handler Prompt

Map correction text to one of:
- `knowledge_correction`
- `persona_correction`
- `metadata_correction`

Output JSON:

```json
{
  "scope": "knowledge|persona|metadata",
  "message": "",
  "apply_immediately": true
}
```
