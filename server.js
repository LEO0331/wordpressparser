import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeWordPressData } from "./src/parser.js";
import { analyzeCorpus, buildProfileArtifacts, generateArtifacts } from "./src/generator.js";
import { fetchByUrl } from "./src/url_extract.js";
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
const ADMIN_API_KEY = String(process.env.ADMIN_API_KEY || "").trim();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

app.use(express.json({ limit: "20mb" }));
app.use(express.static(publicDir));

function logServerError(context, error) {
  // eslint-disable-next-line no-console
  console.error(`[${context}]`, error);
}

function sendSafeError(res, {
  status = 500,
  message = "Internal server error.",
  context = "server",
  error
}) {
  if (error) {
    logServerError(context, error);
  }
  return res.status(status).json({ error: message });
}

function readAdminKey(req) {
  const headerValue = String(req.get("x-admin-key") || "").trim();
  if (headerValue) return headerValue;
  const authHeader = String(req.get("authorization") || "");
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  return bearerMatch ? bearerMatch[1].trim() : "";
}

function requireAdminForMutation(req, res, next) {
  if (!ADMIN_API_KEY) {
    return sendSafeError(res, {
      status: 503,
      message: "Admin actions are not configured.",
      context: "admin-auth"
    });
  }
  if (readAdminKey(req) !== ADMIN_API_KEY) {
    return sendSafeError(res, {
      status: 403,
      message: "Forbidden.",
      context: "admin-auth"
    });
  }
  return next();
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
    sendSafeError(res, {
      status: 400,
      message: "Invalid source payload.",
      context: "normalize",
      error
    });
  }
});

app.post("/api/extract-url", async (req, res) => {
  try {
    const url = req.body?.url;
    const platform = req.body?.platform ?? "auto";
    if (!url) return res.status(400).json({ error: "Missing url" });
    const items = await fetchByUrl(url, platform);
    res.json({
      items,
      metadata: { itemCount: items.length }
    });
  } catch (error) {
    sendSafeError(res, {
      status: 400,
      message: "Failed to extract content from URL.",
      context: "extract-url",
      error
    });
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
    sendSafeError(res, {
      status: 500,
      message: "Failed to analyze corpus.",
      context: "analyze",
      error
    });
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
    sendSafeError(res, {
      status: 500,
      message: "Failed to build profile artifacts.",
      context: "build",
      error
    });
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
    sendSafeError(res, {
      status: 500,
      message: "Failed to save profile.",
      context: "profiles-save",
      error
    });
  }
});

app.get("/api/profiles", async (_req, res) => {
  try {
    const profiles = await listProfiles();
    res.json({ profiles });
  } catch (error) {
    sendSafeError(res, {
      status: 500,
      message: "Failed to list profiles.",
      context: "profiles-list",
      error
    });
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
    sendSafeError(res, {
      status: 404,
      message: "Profile not found.",
      context: "profiles-read",
      error
    });
  }
});

app.post("/api/profiles/:slug/update", requireAdminForMutation, async (req, res) => {
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
    sendSafeError(res, {
      status: 500,
      message: "Failed to update profile.",
      context: "profiles-update",
      error
    });
  }
});

app.post("/api/profiles/:slug/correct", requireAdminForMutation, async (req, res) => {
  try {
    const slug = toSlug(req.params.slug);
    const correction = String(req.body?.correction || "").trim();
    const scope = String(req.body?.scope || "persona");
    if (!correction) return res.status(400).json({ error: "Missing correction text." });
    const result = await applyProfileCorrection(slug, scope, correction);
    res.json(result);
  } catch (error) {
    sendSafeError(res, {
      status: 500,
      message: "Failed to apply correction.",
      context: "profiles-correct",
      error
    });
  }
});

app.post("/api/profiles/:slug/rollback", requireAdminForMutation, async (req, res) => {
  try {
    const slug = toSlug(req.params.slug);
    const version = req.body?.version;
    if (!version) return res.status(400).json({ error: "Missing version." });
    const result = await rollbackProfileStore(slug, version);
    res.json(result);
  } catch (error) {
    sendSafeError(res, {
      status: 500,
      message: "Failed to rollback profile.",
      context: "profiles-rollback",
      error
    });
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
    sendSafeError(res, {
      status: 500,
      message: "Failed to generate artifacts.",
      context: "generate",
      error
    });
  }
});

if (!process.env.VERCEL) {
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`wordpress-parser running at http://localhost:${port}`);
  });
}

export default app;
