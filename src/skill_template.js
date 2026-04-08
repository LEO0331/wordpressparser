function compact(values) {
  return values.filter((v) => typeof v === "string" && v.trim());
}

export function buildSkillMarkdown({
  slug,
  name,
  descriptionParts,
  language,
  knowledgeType,
  primaryTopics,
  optionalIdentity,
  knowledgeMarkdown,
  personaMarkdown
}) {
  const description = compact(descriptionParts).join(", ");
  const identityParts = compact([
    language,
    knowledgeType,
    primaryTopics?.length ? primaryTopics.join(" / ") : "",
    optionalIdentity
  ]);

  return `---
name: knowledge-${slug}
description: "${description || name}"
user-invocable: true
---

# ${name}

${identityParts.join(" · ") || "Author knowledge profile"}

---

## PART A: Knowledge

${knowledgeMarkdown}

---

## PART B: Persona

${personaMarkdown}

---

## Execution Rules

1. Use PART A for factual grounding and domain context.
2. Use PART B for writing tone, structure, and style choices.
3. If source evidence is missing, state uncertainty clearly.
4. Output only in English or Traditional Chinese.
`;
}
