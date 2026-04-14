import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeWordPressData } from "./src/parser.js";
import { analyzeCorpus, buildProfileArtifacts, generateArtifacts } from "./src/generator.js";
import {
  applyProfileCorrection,
  listProfiles,
  listProfileVersions,
  readNormalizedItems,
  readProfile,
  rollbackProfileStore,
  saveProfile,
  toSlug
} from "./src/profile_store.js";

const app = express();
const port = Number(process.env.PORT || 3000);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

app.use(express.json({ limit: "20mb" }));
app.use(express.static(publicDir));

function sanitizeSiteUrl(input) {
  const url = new URL(input);
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error("Only http/https URLs are supported.");
  }
  return {
    baseUrl: `${url.protocol}//${url.host}`,
    host: url.host
  };
}

async function fetchWpRestItems(baseUrl, endpoint) {
  const results = [];
  for (let page = 1; page <= 20; page++) {
    const requestUrl = `${baseUrl}/wp-json/wp/v2/${endpoint}?per_page=100&page=${page}`;
    const res = await fetch(requestUrl);
    if (!res.ok) {
      if (res.status === 400 || res.status === 404) break;
      throw new Error(`${endpoint} request failed with ${res.status}`);
    }
    const body = await res.json();
    if (!Array.isArray(body) || body.length === 0) break;
    results.push(...body);
    if (body.length < 100) break;
  }
  return results;
}

async function fetchWpComItems(host, postType = "post") {
  const items = [];
  for (let page = 1; page <= 20; page++) {
    const endpoint = `https://public-api.wordpress.com/rest/v1.1/sites/${encodeURIComponent(host)}/posts`;
    const params = new URLSearchParams({
      number: "100",
      page: String(page),
      order: "DESC",
      order_by: "date",
      type: postType
    });
    const res = await fetch(`${endpoint}?${params.toString()}`);
    if (!res.ok) {
      if (res.status === 400 || res.status === 404) break;
      throw new Error(`WordPress.com API request failed (${res.status})`);
    }
    const body = await res.json();
    const posts = Array.isArray(body?.posts) ? body.posts : [];
    if (posts.length === 0) break;
    items.push(...posts);
    if (posts.length < 100) break;
  }
  return items;
}

async function fetchWordPressByUrl(inputUrl) {
  const { baseUrl, host } = sanitizeSiteUrl(inputUrl);
  let posts = [];
  let pages = [];
  let wpV2Error = null;

  try {
    posts = await fetchWpRestItems(baseUrl, "posts");
    pages = await fetchWpRestItems(baseUrl, "pages");
  } catch (error) {
    wpV2Error = error;
  }

  if (posts.length === 0 && pages.length === 0) {
    const wpcomPosts = await fetchWpComItems(host, "post");
    const wpcomPages = await fetchWpComItems(host, "page");
    posts = [...wpcomPosts, ...wpcomPages];
  }

  if (posts.length === 0 && pages.length === 0 && wpV2Error) {
    throw new Error(`Unable to fetch WordPress data from URL: ${wpV2Error.message}`);
  }

  return normalizeWordPressData({
    posts: [...posts, ...pages]
  });
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    aiConfigured: Boolean(process.env.OPENAI_API_KEY),
    blobConfigured: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    timestamp: new Date().toISOString()
  });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.post("/api/normalize", (req, res) => {
  try {
    const items = normalizeWordPressData(req.body?.data);
    res.json({
      items,
      metadata: { itemCount: items.length }
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/extract-url", async (req, res) => {
  try {
    const url = req.body?.url;
    if (!url) return res.status(400).json({ error: "Missing url" });
    const items = await fetchWordPressByUrl(url);
    res.json({
      items,
      metadata: { itemCount: items.length }
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/analyze", (req, res) => {
  try {
    const items = req.body?.items;
    const options = req.body?.options ?? {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items to analyze." });
    }
    const result = analyzeCorpus(items, options);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/build", async (req, res) => {
  try {
    const slug = toSlug(req.body?.slug || "author-profile");
    const name = req.body?.name || "Author";
    const items = req.body?.items;
    const options = req.body?.options ?? {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items to build from." });
    }

    const artifacts = await buildProfileArtifacts({
      slug,
      name,
      items,
      options
    });
    res.json(artifacts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/profiles/save", async (req, res) => {
  try {
    const slug = toSlug(req.body?.slug);
    const name = req.body?.name || "Author";
    const items = req.body?.items;
    const options = req.body?.options ?? {};
    const rawSource = req.body?.rawSource;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items to save." });
    }

    const artifacts = await buildProfileArtifacts({
      slug,
      name,
      items,
      options
    });

    const saveResult = await saveProfile({
      slug,
      meta: artifacts.meta,
      knowledgeMarkdown: artifacts.knowledgeMarkdown,
      personaMarkdown: artifacts.personaMarkdown,
      skillMarkdown: artifacts.skillMarkdown,
      wikiMarkdown: artifacts.wikiMarkdown,
      knowledgeAnalysis: artifacts.knowledgeAnalysis,
      personaAnalysis: artifacts.personaAnalysis,
      rawSource,
      normalizedItems: items
    });

    res.json({
      ...artifacts,
      storage: saveResult
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/profiles", async (_req, res) => {
  try {
    const profiles = await listProfiles();
    res.json({ profiles });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/profiles/:slug", async (req, res) => {
  try {
    const profile = await readProfile(req.params.slug);
    const versions = await listProfileVersions(profile.slug);
    res.json({
      ...profile,
      versions
    });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.post("/api/profiles/:slug/update", async (req, res) => {
  try {
    const slug = toSlug(req.params.slug);
    const incomingItems = req.body?.items;
    const options = req.body?.options ?? {};

    let baseItems = [];
    try {
      baseItems = await readNormalizedItems(slug);
    } catch {
      baseItems = [];
    }

    const merged = [...baseItems, ...(Array.isArray(incomingItems) ? incomingItems : [])];
    if (!merged.length) {
      return res.status(400).json({ error: "No profile data to update." });
    }

    const prior = await readProfile(slug);
    const artifacts = await buildProfileArtifacts({
      slug,
      name: prior.meta.name || slug,
      items: merged,
      options
    });

    const saved = await saveProfile({
      slug,
      meta: {
        ...artifacts.meta,
        created_at: prior.meta.created_at,
        updated_at: new Date().toISOString()
      },
      knowledgeMarkdown: artifacts.knowledgeMarkdown,
      personaMarkdown: artifacts.personaMarkdown,
      skillMarkdown: artifacts.skillMarkdown,
      wikiMarkdown: artifacts.wikiMarkdown,
      knowledgeAnalysis: artifacts.knowledgeAnalysis,
      personaAnalysis: artifacts.personaAnalysis,
      normalizedItems: merged
    });

    res.json({ ...artifacts, storage: saved });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/profiles/:slug/correct", async (req, res) => {
  try {
    const slug = toSlug(req.params.slug);
    const correction = String(req.body?.correction || "").trim();
    const scope = String(req.body?.scope || "persona");
    if (!correction) return res.status(400).json({ error: "Missing correction text." });
    const result = await applyProfileCorrection(slug, scope, correction);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/profiles/:slug/rollback", async (req, res) => {
  try {
    const slug = toSlug(req.params.slug);
    const version = req.body?.version;
    if (!version) return res.status(400).json({ error: "Missing version." });
    const result = await rollbackProfileStore(slug, version);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/generate", async (req, res) => {
  try {
    const items = req.body?.items;
    const options = req.body?.options ?? {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items to generate from." });
    }
    const artifacts = await generateArtifacts(items, options);
    res.json(artifacts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

if (!process.env.VERCEL) {
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`wordpress-parser running at http://localhost:${port}`);
  });
}

export default app;
