import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeWordPressData } from "./src/parser.js";
import { analyzeCorpus, buildProfileArtifacts, generateArtifacts } from "./src/generator.js";
import { fetchByUrl } from "./src/url_extract.js";
import { convertWordPressXmlToObsidian, parseMultipartXmlUpload } from "./src/xml_bridge.js";
import {
  applyProfileCorrection,
  listProfiles,
  listProfileVersions,
  readIdempotencyRecord,
  readNormalizedItems,
  readProfile,
  rollbackProfileStore,
  saveProfile,
  toSlug,
  writeIdempotencyRecord
} from "./src/profile_store.js";

const app = express();
const port = Number(process.env.PORT || 3000);
const ADMIN_API_KEY = String(process.env.ADMIN_API_KEY || "").trim();
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

app.use(express.json({ limit: "20mb" }));
app.use(express.static(publicDir));

export function logServerError(context, error) {
  // eslint-disable-next-line no-console
  console.error(`[${context}]`, error);
}

export function sendSafeError(res, {
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

export function readAdminKey(req) {
  const headerValue = String(req.get("x-admin-key") || "").trim();
  if (headerValue) return headerValue;
  const authHeader = String(req.get("authorization") || "");
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  return bearerMatch ? bearerMatch[1].trim() : "";
}

export function requireAdminForMutation(req, res, next, expectedAdminKey = ADMIN_API_KEY) {
  if (!expectedAdminKey) {
    return sendSafeError(res, {
      status: 503,
      message: "Admin actions are not configured.",
      context: "admin-auth"
    });
  }
  if (readAdminKey(req) !== expectedAdminKey) {
    return sendSafeError(res, {
      status: 403,
      message: "Forbidden.",
      context: "admin-auth"
    });
  }
  return next();
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashValue(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function readIdempotencyKey(req) {
  const value = String(req.get?.("idempotency-key") || "").trim();
  return value.length >= 8 && value.length <= 200 ? value : "";
}

function idempotencyRecordKey({ route, slug, key }) {
  return crypto
    .createHash("sha256")
    .update(`${route}\n${slug}\n${key}`)
    .digest("hex");
}

function isFreshIdempotencyRecord(record) {
  const createdAt = Date.parse(record?.createdAt || "");
  return Number.isFinite(createdAt) && Date.now() - createdAt <= IDEMPOTENCY_TTL_MS;
}

function withIdempotency({ route, getSlug }, handler) {
  return async (req, res, next) => {
    const key = readIdempotencyKey(req);
    if (!key) return handler(req, res, next);

    const slug = toSlug(getSlug(req));
    const requestHash = hashValue({ body: req.body ?? null, params: req.params ?? null });
    const recordKey = idempotencyRecordKey({ route, slug, key });

    try {
      const existing = await readIdempotencyRecord(recordKey).catch(() => null);
      if (existing && isFreshIdempotencyRecord(existing)) {
        if (existing.requestHash !== requestHash) {
          return res.status(409).json({ error: "Idempotency key reused with a different request." });
        }
        return res.status(existing.status).json(existing.response);
      }

      let status = 200;
      let response;
      const proxyRes = Object.create(res);
      proxyRes.status = (code) => {
        status = code;
        return proxyRes;
      };
      proxyRes.json = (payload) => {
        response = payload;
        return proxyRes;
      };

      await handler(req, proxyRes, next);
      if (response === undefined) return undefined;

      await writeIdempotencyRecord(recordKey, {
        key,
        route,
        slug,
        requestHash,
        status,
        response,
        createdAt: new Date().toISOString()
      });
      return res.status(status).json(response);
    } catch (error) {
      return sendSafeError(res, {
        status: 500,
        message: "Failed to process idempotent request.",
        context: "idempotency",
        error
      });
    }
  };
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

export function handleConvertXmlRequest(req, res) {
  const knownClientCodes = new Set(["invalid_xml", "unsupported_format", "empty_export"]);
  try {
    const contentType = typeof req.get === "function"
      ? req.get("content-type")
      : req.headers?.["content-type"] ?? "";
    const xmlText = parseMultipartXmlUpload(req.body, contentType);
    const { zipBuffer, metadata } = convertWordPressXmlToObsidian(xmlText);
    const headerMetadata = {
      totalItems: metadata.totalItems,
      convertedItems: metadata.convertedItems,
      skippedItems: metadata.skippedItems,
      warningCount: metadata.warningCount,
      firstWarning: Array.isArray(metadata.warnings) && metadata.warnings.length
        ? String(metadata.warnings[0]).slice(0, 240)
        : ""
    };
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", "attachment; filename=\"obsidian-export.zip\"");
    res.setHeader("X-Conversion-Report", encodeURIComponent(JSON.stringify(headerMetadata)));
    return res.status(200).send(zipBuffer);
  } catch (error) {
    const code = String(error?.code || "");
    const status = knownClientCodes.has(code) ? 400 : 500;
    const message = status === 400
      ? error.message
      : "Failed to convert XML export.";
    return sendSafeError(res, {
      status,
      message,
      context: "convert-xml",
      error: status === 400 ? undefined : error
    });
  }
}

app.post(
  "/api/convert-xml",
  express.raw({ type: "multipart/form-data", limit: "25mb" }),
  handleConvertXmlRequest
);

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

app.post(
  "/api/profiles/save",
  withIdempotency({ route: "profiles-save", getSlug: (req) => req.body?.slug }, async (req, res) => {
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
  })
);

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

app.post(
  "/api/profiles/:slug/update",
  requireAdminForMutation,
  withIdempotency({ route: "profiles-update", getSlug: (req) => req.params.slug }, async (req, res) => {
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
  })
);

app.post(
  "/api/profiles/:slug/correct",
  requireAdminForMutation,
  withIdempotency({ route: "profiles-correct", getSlug: (req) => req.params.slug }, async (req, res) => {
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
  })
);

app.post(
  "/api/profiles/:slug/rollback",
  requireAdminForMutation,
  withIdempotency({ route: "profiles-rollback", getSlug: (req) => req.params.slug }, async (req, res) => {
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
  })
);

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
