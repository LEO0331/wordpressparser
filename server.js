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
const API_VERSION = "2026-06-11";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

app.use((req, res, next) => {
  const inboundRequestId = String(req.get?.("x-request-id") || "").trim();
  const requestId = /^req_[a-zA-Z0-9_-]{8,80}$/.test(inboundRequestId)
    ? inboundRequestId
    : `req_${crypto.randomUUID().replace(/-/g, "")}`;
  req.requestId = requestId;
  res.locals.requestId = requestId;
  res.setHeader("Request-Id", requestId);
  res.setHeader("API-Version", API_VERSION);
  next();
});

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
  error,
  type,
  code,
  param
}) {
  if (error) {
    logServerError(context, error);
  }
  return sendApiError(res, { status, message, type, code: code || context, param });
}

function errorTypeForStatus(status) {
  if (status === 401) return "authentication_error";
  if (status === 403) return "authorization_error";
  if (status === 404) return "not_found_error";
  if (status === 409) return "idempotency_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

function responseRequestId(res) {
  if (!res.locals) res.locals = {};
  if (!res.locals.requestId) {
    res.locals.requestId = `req_${crypto.randomUUID().replace(/-/g, "")}`;
  }
  if (typeof res.setHeader === "function") {
    res.setHeader("Request-Id", res.locals.requestId);
    res.setHeader("API-Version", API_VERSION);
  }
  return res.locals.requestId;
}

function sendApiError(res, {
  status = 400,
  message,
  type,
  code,
  param
}) {
  const requestId = responseRequestId(res);
  return res.status(status).json({
    error: message,
    request_id: requestId,
    error_details: {
      type: type || errorTypeForStatus(status),
      code: code || "invalid_request",
      message,
      ...(param ? { param } : {}),
      request_id: requestId
    }
  });
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
          logServerError("idempotency", new Error(`Key collision on ${route}/${slug}`));
          return sendApiError(res, {
            status: 409,
            type: "idempotency_error",
            code: "idempotency_key_reused_with_different_params",
            message: "Idempotency key reused with a different request."
          });
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
    if (!url) {
      return sendApiError(res, {
        status: 400,
        code: "missing_required_param",
        message: "Missing url",
        param: "url"
      });
    }
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
      return sendApiError(res, {
        status: 400,
        code: "missing_required_param",
        message: "No items to analyze.",
        param: "items"
      });
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
      return sendApiError(res, {
        status: 400,
        code: "missing_required_param",
        message: "No items to build from.",
        param: "items"
      });
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
        return sendApiError(res, {
          status: 400,
          code: "missing_required_param",
          message: "No items to save.",
          param: "items"
        });
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

app.get("/api/profiles", async (req, res) => {
  try {
    const profiles = await listProfiles();
    const limitInput = Number(req.query?.limit ?? 100);
    const limit = Number.isFinite(limitInput)
      ? Math.min(Math.max(Math.trunc(limitInput), 1), 100)
      : 100;
    const startingAfter = String(req.query?.starting_after || "").trim();
    const startIndex = startingAfter
      ? profiles.findIndex((profile) => profile.slug === startingAfter) + 1
      : 0;
    const safeStartIndex = startIndex > 0 ? startIndex : 0;
    const page = profiles.slice(safeStartIndex, safeStartIndex + limit);
    res.json({
      object: "list",
      data: page,
      profiles: page,
      has_more: safeStartIndex + limit < profiles.length,
      url: "/api/profiles"
    });
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
        return sendApiError(res, {
          status: 400,
          code: "missing_required_param",
          message: "No profile data to update.",
          param: "items"
        });
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
      if (!correction) {
        return sendApiError(res, {
          status: 400,
          code: "missing_required_param",
          message: "Missing correction text.",
          param: "correction"
        });
      }
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
      if (!version) {
        return sendApiError(res, {
          status: 400,
          code: "missing_required_param",
          message: "Missing version.",
          param: "version"
        });
      }
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
      return sendApiError(res, {
        status: 400,
        code: "missing_required_param",
        message: "No items to generate from.",
        param: "items"
      });
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
