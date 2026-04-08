const state = {
  sourceMode: "json",
  items: [],
  skillMarkdown: "",
  rag: [],
  activeOutput: "skill"
};

const el = {
  sourceJsonBtn: document.getElementById("sourceJsonBtn"),
  sourceUrlBtn: document.getElementById("sourceUrlBtn"),
  jsonSource: document.getElementById("jsonSource"),
  urlSource: document.getElementById("urlSource"),
  jsonFile: document.getElementById("jsonFile"),
  jsonText: document.getElementById("jsonText"),
  wpUrl: document.getElementById("wpUrl"),
  languageMode: document.getElementById("languageMode"),
  outputMode: document.getElementById("outputMode"),
  presetMode: document.getElementById("presetMode"),
  parseBtn: document.getElementById("parseBtn"),
  generateBtn: document.getElementById("generateBtn"),
  status: document.getElementById("status"),
  stats: document.getElementById("stats"),
  tabSkill: document.getElementById("tabSkill"),
  tabRag: document.getElementById("tabRag"),
  output: document.getElementById("output"),
  downloadSkillBtn: document.getElementById("downloadSkillBtn"),
  downloadRagBtn: document.getElementById("downloadRagBtn")
};

function setStatus(message, isError = false) {
  el.status.textContent = message;
  el.status.style.color = isError ? "#8f2f2f" : "#2e2a21";
}

function switchSource(mode) {
  state.sourceMode = mode;
  const isJson = mode === "json";
  el.sourceJsonBtn.classList.toggle("active", isJson);
  el.sourceUrlBtn.classList.toggle("active", !isJson);
  el.jsonSource.classList.toggle("hidden", !isJson);
  el.urlSource.classList.toggle("hidden", isJson);
}

function switchOutputTab(tab) {
  state.activeOutput = tab;
  el.tabSkill.classList.toggle("active", tab === "skill");
  el.tabRag.classList.toggle("active", tab === "rag");

  if (tab === "skill") {
    el.output.textContent = state.skillMarkdown || "No skill.md generated yet.";
  } else {
    el.output.textContent = state.rag.length
      ? JSON.stringify(state.rag, null, 2)
      : "No rag.json generated yet.";
  }
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errorPayload = await res.json().catch(() => ({}));
    throw new Error(errorPayload.error || `Request failed (${res.status})`);
  }
  return res.json();
}

async function parseFromJson() {
  const rawText = el.jsonText.value.trim();
  if (rawText) {
    try {
      const payload = JSON.parse(rawText);
      return postJson("/api/normalize", { data: payload });
    } catch {
      throw new Error("Invalid pasted JSON format.");
    }
  }

  const file = el.jsonFile.files[0];
  if (!file) throw new Error("Choose a JSON file or paste raw JSON.");

  const text = await file.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON format.");
  }

  return postJson("/api/normalize", { data: payload });
}

async function parseFromUrl() {
  const url = el.wpUrl.value.trim();
  if (!url) throw new Error("Enter a WordPress URL.");
  return postJson("/api/extract-url", { url });
}

function renderStats(items, metadata) {
  el.stats.classList.remove("hidden");
  const sample = items[0]?.title ? `Latest title: ${items[0].title}` : "No title available.";
  el.stats.textContent = `Parsed ${metadata.itemCount} entries. ${sample}`;
}

function downloadText(filename, content) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function handleParse() {
  try {
    setStatus("Parsing source...");
    const parsed = state.sourceMode === "json" ? await parseFromJson() : await parseFromUrl();
    state.items = parsed.items || [];
    if (!state.items.length) {
      throw new Error("No parseable content found.");
    }
    renderStats(state.items, parsed.metadata || { itemCount: state.items.length });
    el.generateBtn.disabled = false;
    setStatus(`Parsed ${state.items.length} items. Ready to generate.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function handleGenerate() {
  try {
    if (!state.items.length) throw new Error("Parse data first.");
    setStatus("Generating artifacts...");
    const mode = el.outputMode.value;
    const response = await postJson("/api/generate", {
      items: state.items,
      options: {
        language: el.languageMode.value,
        preset: el.presetMode.value
      }
    });

    state.skillMarkdown = response.skillMarkdown || "";
    state.rag = mode === "both" ? response.rag || [] : [];
    switchOutputTab("skill");

    el.downloadSkillBtn.disabled = !state.skillMarkdown;
    el.downloadRagBtn.disabled = !(mode === "both" && state.rag.length);

    const engine = response.metadata?.aiUsed ? "AI model" : "fallback profile builder";
    setStatus(`Generation done using ${engine}. Preset: ${response.metadata?.preset || el.presetMode.value}.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

el.sourceJsonBtn.addEventListener("click", () => switchSource("json"));
el.sourceUrlBtn.addEventListener("click", () => switchSource("url"));
el.parseBtn.addEventListener("click", handleParse);
el.generateBtn.addEventListener("click", handleGenerate);
el.tabSkill.addEventListener("click", () => switchOutputTab("skill"));
el.tabRag.addEventListener("click", () => switchOutputTab("rag"));
el.downloadSkillBtn.addEventListener("click", () => {
  if (state.skillMarkdown) downloadText("skill.md", state.skillMarkdown);
});
el.downloadRagBtn.addEventListener("click", () => {
  if (state.rag.length) {
    downloadText("rag.json", JSON.stringify(state.rag, null, 2));
  }
});

switchSource("json");
switchOutputTab("skill");
