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
  const isZh = language === "zh-TW";
  const description = compact(descriptionParts).join(", ");
  const identityParts = compact([
    language,
    knowledgeType,
    primaryTopics?.length ? primaryTopics.join(" / ") : "",
    optionalIdentity
  ]);
  const fallbackIdentity = isZh ? "作者知識設定檔" : "Author knowledge profile";
  const profileSnapshotTitle = isZh ? "## 個人檔案摘要" : "## Profile Snapshot";
  const profileNameLabel = isZh ? "名稱" : "Name";
  const profileLanguageLabel = isZh ? "語言" : "Language";
  const profileTopicsLabel = isZh ? "主要主題" : "Primary topics";
  const profileKnowledgeLabel = isZh ? "知識類型" : "Knowledge type";
  const partAKnowledge = isZh ? "## PART A: 知識庫" : "## PART A: Knowledge";
  const partBPersona = isZh ? "## PART B: 人設風格" : "## PART B: Persona";
  const executionRulesTitle = isZh ? "## 執行規則" : "## Execution Rules";
  const responseChecklistTitle = isZh ? "## 回覆檢查清單" : "## Response Checklist";
  const ruleLines = isZh
    ? [
        "1. 先使用 PART A 進行事實判斷與領域脈絡建模。",
        "2. 再使用 PART B 決定語氣、段落節奏與結構。",
        "3. 若來源證據不足，必須明確標記不確定性。",
        "4. 輸出語言僅限英文或繁體中文，並遵守使用者指定語言。"
      ]
    : [
        "1. Use PART A for factual grounding and domain context.",
        "2. Use PART B for writing tone, structure, and style choices.",
        "3. If source evidence is missing, state uncertainty clearly.",
        "4. Output only in English or Traditional Chinese and obey user language selection."
      ];
  const checklistLines = isZh
    ? [
        "- 回覆前先確認主張是否可追溯到來源內容。",
        "- 優先給出結論，再補必要解釋與可執行建議。",
        "- 當需求不完整時，先說明限制再提出可行方案。"
      ]
    : [
        "- Validate claims against source-backed evidence before answering.",
        "- Lead with the conclusion, then provide concise rationale and actions.",
        "- If context is insufficient, state constraints before proposing next steps."
      ];

  return `---
name: knowledge-${slug}
description: "${description || name}"
user-invocable: true
---

# ${name}

${identityParts.join(" · ") || fallbackIdentity}

---

${profileSnapshotTitle}

- ${profileNameLabel}: ${name}
- ${profileLanguageLabel}: ${language}
- ${profileTopicsLabel}: ${primaryTopics?.length ? primaryTopics.join(", ") : (isZh ? "未提供" : "not provided")}
- ${profileKnowledgeLabel}: ${knowledgeType || (isZh ? "未提供" : "not provided")}

---

${partAKnowledge}

${knowledgeMarkdown}

---

${partBPersona}

${personaMarkdown}

---

${executionRulesTitle}

${ruleLines.join("\n")}

---

${responseChecklistTitle}

${checklistLines.join("\n")}
`;
}
