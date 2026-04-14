const state = {
  sourceMode: "json",
  items: [],
  parsedRawSource: null,
  skillMarkdown: "",
  knowledgeMarkdown: "",
  personaMarkdown: "",
  meta: null,
  wikiMarkdown: "",
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
  platformMode: document.getElementById("platformMode"),
  profileSlug: document.getElementById("profileSlug"),
  profileName: document.getElementById("profileName"),
  languageMode: document.getElementById("languageMode"),
  outputMode: document.getElementById("outputMode"),
  generationMode: document.getElementById("generationMode"),
  parseBtn: document.getElementById("parseBtn"),
  generateBtn: document.getElementById("generateBtn"),
  saveBtn: document.getElementById("saveBtn"),
  status: document.getElementById("status"),
  stats: document.getElementById("stats"),
  tabSkill: document.getElementById("tabSkill"),
  tabWiki: document.getElementById("tabWiki"),
  output: document.getElementById("output"),
  downloadSkillBtn: document.getElementById("downloadSkillBtn"),
  downloadWikiBtn: document.getElementById("downloadWikiBtn")
};

function setStatus(message, options = {}) {
  const normalized =
    typeof options === "boolean" ? { isError: options, isLoading: false } : options;
  const { isError = false, isLoading = false } = normalized;
  el.status.classList.toggle("is-loading", isLoading);
  el.status.innerHTML = "";
  if (isLoading) {
    const spinner = document.createElement("span");
    spinner.className = "status-spinner";
    spinner.setAttribute("aria-hidden", "true");
    el.status.appendChild(spinner);
  }
  const text = document.createElement("span");
  text.textContent = message;
  el.status.appendChild(text);
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
  el.tabWiki.classList.toggle("active", tab === "wiki");

  if (tab === "skill") {
    el.output.textContent = state.skillMarkdown || "No skill.md generated yet.";
  } else {
    el.output.textContent = state.wikiMarkdown || "No wiki.md generated yet.";
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
      const parsed = await postJson("/api/normalize", { data: payload });
      state.parsedRawSource = payload;
      return parsed;
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

  const parsed = await postJson("/api/normalize", { data: payload });
  state.parsedRawSource = payload;
  return parsed;
}

async function parseFromUrl() {
  const url = el.wpUrl.value.trim();
  if (!url) throw new Error("Enter a WordPress or PIXNET URL.");
  const platform = el.platformMode?.value || "auto";
  state.parsedRawSource = { url, platform };
  return postJson("/api/extract-url", { url, platform });
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
    setStatus("Parsing source...", { isLoading: true });
    const parsed = state.sourceMode === "json" ? await parseFromJson() : await parseFromUrl();
    state.items = parsed.items || [];
    if (!state.items.length) {
      throw new Error("No parseable content found.");
    }
    renderStats(state.items, parsed.metadata || { itemCount: state.items.length });
    el.generateBtn.disabled = false;
    el.saveBtn.disabled = true;
    setStatus(`Parsed ${state.items.length} items. Ready to generate.`);
  } catch (error) {
    setStatus(error.message, { isError: true });
  }
}

async function handleGenerate() {
  try {
    if (!state.items.length) throw new Error("Parse data first.");
    setStatus("Generating artifacts...", { isLoading: true });
    const mode = el.outputMode.value;
    const slug = el.profileSlug.value.trim() || "author-profile";
    const name = el.profileName.value.trim() || "Author";
    const response = await postJson("/api/generate", {
      items: state.items,
      options: {
        language: el.languageMode.value,
        mode: el.generationMode.value,
        slug,
        name
      },
      slug,
      name
    });

    state.skillMarkdown = response.skillMarkdown || "";
    state.knowledgeMarkdown = response.knowledgeMarkdown || "";
    state.personaMarkdown = response.personaMarkdown || "";
    state.meta = response.meta || null;
    state.wikiMarkdown = mode === "both" ? response.wikiMarkdown || "" : "";
    switchOutputTab("skill");

    el.downloadSkillBtn.disabled = !state.skillMarkdown;
    el.downloadWikiBtn.disabled = !(mode === "both" && state.wikiMarkdown);
    el.saveBtn.disabled = !state.skillMarkdown;

    const engine = response.metadata?.aiUsed ? "AI model" : "parser mode";
    setStatus(`Generation done using ${engine}. Effective mode: ${response.metadata?.modeUsed || "parser"}.`);
  } catch (error) {
    setStatus(error.message, { isError: true });
  }
}

async function handleSave() {
  try {
    if (!state.items.length || !state.skillMarkdown) {
      throw new Error("Generate artifacts before saving.");
    }
    setStatus("Saving profile...", { isLoading: true });
    const slug = el.profileSlug.value.trim() || "author-profile";
    const name = el.profileName.value.trim() || "Author";

    const response = await postJson("/api/profiles/save", {
      slug,
      name,
      items: state.items,
      rawSource: state.parsedRawSource,
      options: {
        language: el.languageMode.value,
        mode: el.generationMode.value,
        sourceTypes: [
          state.sourceMode === "json"
            ? "wordpress_json"
            : el.platformMode?.value === "pixnet"
              ? "pixnet_url"
              : el.platformMode?.value === "wordpress"
                ? "wordpress_url"
                : "web_url_auto"
        ]
      }
    });

    setStatus(`Saved profile '${response.storage?.slug}' to ${response.storage?.profileDir}.`);
  } catch (error) {
    setStatus(error.message, { isError: true });
  }
}

el.sourceJsonBtn.addEventListener("click", () => switchSource("json"));
el.sourceUrlBtn.addEventListener("click", () => switchSource("url"));
el.parseBtn.addEventListener("click", handleParse);
el.generateBtn.addEventListener("click", handleGenerate);
el.saveBtn.addEventListener("click", handleSave);
el.tabSkill.addEventListener("click", () => switchOutputTab("skill"));
el.tabWiki.addEventListener("click", () => switchOutputTab("wiki"));
el.downloadSkillBtn.addEventListener("click", () => {
  if (state.skillMarkdown) downloadText("skill.md", state.skillMarkdown);
});
el.downloadWikiBtn.addEventListener("click", () => {
  if (state.wikiMarkdown) {
    downloadText("wiki.md", state.wikiMarkdown);
  }
});

switchSource("json");
switchOutputTab("skill");
