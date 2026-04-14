import { stripHtml } from "../src/parser.js";
import { normalizePostFromMarkdown } from "./markdown.js";

const API_VERSIONS = {
  v2: {
    postsPath: "/wp-json/wp/v2/posts"
  },
  v3: {
    // Reserved for future endpoint migration. Falls back to v2 when unavailable.
    postsPath: "/wp-json/wp/v3/posts"
  }
};

function toQuery(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  return search.toString();
}

function normalizeTitle(titleObj) {
  return stripHtml(titleObj?.rendered || titleObj || "").trim();
}

function parseStatus(statusInput) {
  if (!statusInput) return "publish,draft";
  if (Array.isArray(statusInput)) return statusInput.filter(Boolean).join(",");
  return String(statusInput);
}

export class WordPressClient {
  constructor({ baseUrl, username, appPassword, preferredVersion = "v2", timeoutMs = 15000, fetchImpl = fetch }) {
    this.baseUrl = baseUrl;
    this.username = username;
    this.appPassword = appPassword;
    this.preferredVersion = preferredVersion;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.resolvedVersion = null;
    this.versionWarning = null;
  }

  getAuthHeader() {
    const token = Buffer.from(`${this.username}:${this.appPassword}`, "utf8").toString("base64");
    return `Basic ${token}`;
  }

  async request(path, { method = "GET", query = {}, body } = {}) {
    const queryString = toQuery(query);
    const url = `${this.baseUrl}${path}${queryString ? `?${queryString}` : ""}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: this.getAuthHeader(),
          "Content-Type": "application/json"
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });

      const text = await res.text();
      const payload = text ? JSON.parse(text) : null;
      if (!res.ok) {
        const detail = payload?.message || payload?.code || text || `HTTP ${res.status}`;
        const error = new Error(`WordPress request failed (${res.status}): ${detail}`);
        error.status = res.status;
        throw error;
      }

      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  buildVersionCandidates() {
    const preferred = this.preferredVersion in API_VERSIONS ? this.preferredVersion : "v2";
    if (preferred === "v2") return ["v2"];
    return [preferred, "v2"];
  }

  async resolveVersion() {
    if (this.resolvedVersion) {
      return {
        version: this.resolvedVersion,
        warning: this.versionWarning
      };
    }

    const candidates = this.buildVersionCandidates();
    for (const version of candidates) {
      const { postsPath } = API_VERSIONS[version];
      try {
        await this.request(postsPath, {
          query: { per_page: 1, _fields: "id" }
        });
        this.resolvedVersion = version;
        if (version !== candidates[0]) {
          this.versionWarning = `Requested API version '${candidates[0]}' is unavailable. Falling back to '${version}'.`;
        }
        return {
          version,
          warning: this.versionWarning
        };
      } catch (error) {
        if (![400, 401, 403, 404, 405].includes(error.status || 0)) {
          throw error;
        }
      }
    }

    throw new Error("Could not resolve a working WordPress posts endpoint.");
  }

  getPostsPath(version) {
    return API_VERSIONS[version]?.postsPath || API_VERSIONS.v2.postsPath;
  }

  async listPosts({ per_page = 10, page = 1, status, search } = {}) {
    const { version, warning } = await this.resolveVersion();
    const postsPath = this.getPostsPath(version);

    const rows = await this.request(postsPath, {
      query: {
        per_page: Math.min(Math.max(Number(per_page) || 10, 1), 100),
        page: Math.max(Number(page) || 1, 1),
        status: parseStatus(status),
        search: search ? String(search) : undefined,
        _fields: "id,title,status,date,modified,link"
      }
    });

    return {
      warning,
      version,
      posts: (rows || []).map((item) => ({
        id: item.id,
        title: normalizeTitle(item.title),
        status: item.status,
        date: item.date,
        modified: item.modified,
        link: item.link
      }))
    };
  }

  async readPost(postId) {
    const id = Number(postId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error("post_id must be a positive integer.");
    }

    const { version, warning } = await this.resolveVersion();
    const post = await this.request(`${this.getPostsPath(version)}/${id}`, {
      query: {
        _fields: "id,title,status,slug,date,modified,link,excerpt,content,categories,tags"
      }
    });

    return {
      warning,
      version,
      post: {
        id: post.id,
        title: normalizeTitle(post.title),
        status: post.status,
        slug: post.slug,
        date: post.date,
        modified: post.modified,
        link: post.link,
        excerpt_text: stripHtml(post.excerpt?.rendered || ""),
        content_html: post.content?.rendered || "",
        content_text: stripHtml(post.content?.rendered || ""),
        categories: Array.isArray(post.categories) ? post.categories : [],
        tags: Array.isArray(post.tags) ? post.tags : []
      }
    };
  }

  async createDraftFromMarkdown(markdownDoc) {
    const parsed = normalizePostFromMarkdown(markdownDoc);
    const { version, warning } = await this.resolveVersion();

    const requestedStatus = parsed.status;
    const finalStatus = requestedStatus === "publish" ? "draft" : requestedStatus;
    const extraWarning =
      requestedStatus === "publish"
        ? "Frontmatter status 'publish' is not allowed in draft creation and was changed to 'draft'."
        : null;

    const created = await this.request(this.getPostsPath(version), {
      method: "POST",
      body: {
        title: parsed.title,
        status: finalStatus,
        slug: parsed.slug,
        excerpt: parsed.excerpt,
        content: parsed.contentHtml,
        categories: parsed.categories,
        tags: parsed.tags
      }
    });

    return {
      version,
      warning: [warning, extraWarning].filter(Boolean).join(" ") || null,
      post: {
        id: created.id,
        title: normalizeTitle(created.title),
        status: created.status,
        link: created.link
      }
    };
  }

  async updateDraftFromMarkdown(postId, markdownDoc) {
    const id = Number(postId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error("post_id must be a positive integer.");
    }

    const parsed = normalizePostFromMarkdown(markdownDoc);
    const current = await this.readPost(id);
    if (current.post.status !== "draft") {
      throw new Error(`Post ${id} is not draft (current status: ${current.post.status}).`);
    }

    const updated = await this.request(`${this.getPostsPath(current.version)}/${id}`, {
      method: "POST",
      body: {
        title: parsed.title,
        status: "draft",
        slug: parsed.slug,
        excerpt: parsed.excerpt,
        content: parsed.contentHtml,
        categories: parsed.categories,
        tags: parsed.tags
      }
    });

    return {
      version: current.version,
      warning: current.warning,
      post: {
        id: updated.id,
        title: normalizeTitle(updated.title),
        status: updated.status,
        link: updated.link
      }
    };
  }

  async publishPost(postId, confirm) {
    const id = Number(postId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error("post_id must be a positive integer.");
    }
    if (confirm !== true) {
      throw new Error("publish_wp_post requires confirm=true.");
    }

    const { version, warning } = await this.resolveVersion();
    const updated = await this.request(`${this.getPostsPath(version)}/${id}`, {
      method: "POST",
      body: {
        status: "publish"
      }
    });

    return {
      version,
      warning,
      post: {
        id: updated.id,
        title: normalizeTitle(updated.title),
        status: updated.status,
        link: updated.link
      }
    };
  }
}
