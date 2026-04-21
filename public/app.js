const state = {
  sourceMode: "json",
  items: [],
  parsedRawSource: null,
  xmlZipBlob: null,
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
  sourceXmlBtn: document.getElementById("sourceXmlBtn"),
  jsonSource: document.getElementById("jsonSource"),
  urlSource: document.getElementById("urlSource"),
  xmlSource: document.getElementById("xmlSource"),
  jsonFile: document.getElementById("jsonFile"),
  jsonText: document.getElementById("jsonText"),
  xmlFile: document.getElementById("xmlFile"),
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
  downloadXmlBtn: document.getElementById("downloadXmlBtn"),
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
  const isUrl = mode === "url";
  const isXml = mode === "xml";
  el.sourceJsonBtn.classList.toggle("active", isJson);
  el.sourceUrlBtn.classList.toggle("active", isUrl);
  el.sourceXmlBtn.classList.toggle("active", isXml);
  el.jsonSource.classList.toggle("hidden", !isJson);
  el.urlSource.classList.toggle("hidden", !isUrl);
  el.xmlSource.classList.toggle("hidden", !isXml);
  el.parseBtn.textContent = isXml ? "1. Convert XML to Markdown ZIP" : "1. Parse Source";
  el.generateBtn.disabled = isXml || !state.items.length;
  el.saveBtn.disabled = isXml || !state.skillMarkdown;
  el.downloadXmlBtn.disabled = !isXml || !state.xmlZipBlob;
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

function downloadBlob(filename, blob, type = "application/octet-stream") {
  const object = blob instanceof Blob ? blob : new Blob([blob], { type });
  const url = URL.createObjectURL(object);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function convertFromXml() {
  const file = el.xmlFile.files[0];
  if (!file) throw new Error("Choose a WordPress XML file first.");

  const formData = new FormData();
  formData.append("file", file, file.name);

  const res = await fetch("/api/convert-xml", {
    method: "POST",
    body: formData
  });
  if (!res.ok) {
    const errorPayload = await res.json().catch(() => ({}));
    throw new Error(errorPayload.error || `Request failed (${res.status})`);
  }

  const blob = await res.blob();
  const reportHeader = res.headers.get("x-conversion-report");
  let metadata = null;
  if (reportHeader) {
    try {
      metadata = JSON.parse(decodeURIComponent(reportHeader));
    } catch {
      metadata = null;
    }
  }

  return { blob, metadata, filename: file.name };
}

async function handleParse() {
  try {
    if (state.sourceMode === "xml") {
      setStatus("Converting XML export...", { isLoading: true });
      const converted = await convertFromXml();
      state.xmlZipBlob = converted.blob;
      state.parsedRawSource = { xmlFileName: converted.filename };
      state.items = [];
      el.generateBtn.disabled = true;
      el.saveBtn.disabled = true;
      el.downloadXmlBtn.disabled = !state.xmlZipBlob;
      const summary = converted.metadata || {};
      el.stats.classList.remove("hidden");
      const firstWarningText = summary.firstWarning || "";
      const firstWarning = firstWarningText
        ? ` First warning: ${firstWarningText}`
        : "";
      el.stats.textContent = `Converted ${summary.convertedItems || 0}/${summary.totalItems || 0} items, skipped ${summary.skippedItems || 0}, warnings ${summary.warningCount || 0}.${firstWarning}`;
      setStatus("XML conversion completed. Download the ZIP for Obsidian import.");
      return;
    }

    setStatus("Parsing source...", { isLoading: true });
    const parsed = state.sourceMode === "json" ? await parseFromJson() : await parseFromUrl();
    state.xmlZipBlob = null;
    state.items = parsed.items || [];
    if (!state.items.length) {
      throw new Error("No parseable content found.");
    }
    renderStats(state.items, parsed.metadata || { itemCount: state.items.length });
    el.generateBtn.disabled = false;
    el.saveBtn.disabled = true;
    el.downloadXmlBtn.disabled = true;
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
el.sourceXmlBtn.addEventListener("click", () => switchSource("xml"));
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
el.downloadXmlBtn.addEventListener("click", () => {
  if (state.xmlZipBlob) {
    downloadBlob("obsidian-export.zip", state.xmlZipBlob, "application/zip");
  }
});

switchSource("json");
switchOutputTab("skill");
