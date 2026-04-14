import { normalizeWordPressData } from "./parser.js";
import dns from "node:dns/promises";
import net from "node:net";

const MAX_PAGES = 20;
const PAGE_SIZE = 100;
const PLATFORM_VALUES = new Set(["auto", "wordpress", "pixnet"]);
const BLOCKED_HOSTS = new Set(["localhost", "0.0.0.0", "::1"]);

function parseJsonSafe(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function sanitizeSiteUrl(input) {
  const url = new URL(input);
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error("Only http/https URLs are supported.");
  }
  return {
    baseUrl: `${url.protocol}//${url.host}`,
    host: url.host
  };
}

function parseIPv4(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((x) => Number(x));
  if (nums.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return nums;
}

function isPrivateIPv4(ip) {
  const parts = parseIPv4(ip);
  if (!parts) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 0) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIPv6(ip) {
  const normalized = String(ip || "").toLowerCase();
  if (!normalized) return true;
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return isPrivateIPv4(mapped);
  }
  return false;
}

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return true;
}

async function resolveHostAddresses(host, resolver = dns.lookup) {
  const results = await resolver(host, { all: true, verbatim: true });
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error("No DNS records found for host.");
  }
  return results.map((x) => x.address).filter(Boolean);
}

export async function assertSafeExtractionTarget(inputUrl, resolver = dns.lookup) {
  const { host } = sanitizeSiteUrl(inputUrl);
  const lowerHost = host.toLowerCase();
  if (BLOCKED_HOSTS.has(lowerHost) || lowerHost.endsWith(".localhost")) {
    throw new Error("Target host is not allowed.");
  }

  const ipFamily = net.isIP(lowerHost);
  if (ipFamily) {
    if (isPrivateAddress(lowerHost)) {
      throw new Error("Target host resolves to a private or local network address.");
    }
    return;
  }

  const addresses = await resolveHostAddresses(host, resolver);
  if (addresses.some((x) => isPrivateAddress(x))) {
    throw new Error("Target host resolves to a private or local network address.");
  }
}

export function normalizePlatform(platformInput) {
  const normalized = String(platformInput || "auto").trim().toLowerCase();
  return PLATFORM_VALUES.has(normalized) ? normalized : "auto";
}

export function detectPlatformByUrl(inputUrl, platformInput = "auto") {
  const forced = normalizePlatform(platformInput);
  if (forced !== "auto") return forced;
  const { host } = sanitizeSiteUrl(inputUrl);
  if (host.endsWith(".pixnet.net") || host.endsWith(".pixnet.cc") || host === "pixnet.net") {
    return "pixnet";
  }
  return "wordpress";
}

export async function fetchWpRestItems(baseUrl, endpoint, fetchImpl = fetch) {
  const results = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const requestUrl = `${baseUrl}/wp-json/wp/v2/${endpoint}?per_page=${PAGE_SIZE}&page=${page}`;
    const res = await fetchImpl(requestUrl);
    if (!res.ok) {
      if (res.status === 400 || res.status === 404) break;
      throw new Error(`${endpoint} request failed with ${res.status}`);
    }
    const body = await res.json();
    if (!Array.isArray(body) || body.length === 0) break;
    results.push(...body);
    if (body.length < PAGE_SIZE) break;
  }
  return results;
}

export async function fetchWpComItems(host, postType = "post", fetchImpl = fetch) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const endpoint = `https://public-api.wordpress.com/rest/v1.1/sites/${encodeURIComponent(host)}/posts`;
    const params = new URLSearchParams({
      number: String(PAGE_SIZE),
      page: String(page),
      order: "DESC",
      order_by: "date",
      type: postType
    });
    const res = await fetchImpl(`${endpoint}?${params.toString()}`);
    if (!res.ok) {
      if (res.status === 400 || res.status === 404) break;
      throw new Error(`WordPress.com API request failed (${res.status})`);
    }
    const body = await res.json();
    const posts = Array.isArray(body?.posts) ? body.posts : [];
    if (posts.length === 0) break;
    items.push(...posts);
    if (posts.length < PAGE_SIZE) break;
  }
  return items;
}

export async function fetchWordPressByUrl(inputUrl, fetchImpl = fetch, resolver = dns.lookup) {
  await assertSafeExtractionTarget(inputUrl, resolver);
  const { baseUrl, host } = sanitizeSiteUrl(inputUrl);
  let posts = [];
  let pages = [];
  let wpV2Error = null;

  try {
    posts = await fetchWpRestItems(baseUrl, "posts", fetchImpl);
    pages = await fetchWpRestItems(baseUrl, "pages", fetchImpl);
  } catch (error) {
    wpV2Error = error;
  }

  if (posts.length === 0 && pages.length === 0) {
    const wpcomPosts = await fetchWpComItems(host, "post", fetchImpl);
    const wpcomPages = await fetchWpComItems(host, "page", fetchImpl);
    posts = [...wpcomPosts, ...wpcomPages];
  }

  if (posts.length === 0 && pages.length === 0 && wpV2Error) {
    throw new Error(`Unable to fetch WordPress data from URL: ${wpV2Error.message}`);
  }

  return normalizeWordPressData({
    posts: [...posts, ...pages]
  });
}

export function parsePixnetIdentity(inputUrl) {
  const { host } = sanitizeSiteUrl(inputUrl);
  const url = new URL(inputUrl);
  const queryUser = String(url.searchParams.get("user") || "").trim();
  if (queryUser) return queryUser;

  if (host.endsWith(".pixnet.net")) {
    const subdomain = host.slice(0, -".pixnet.net".length);
    const reserved = new Set(["www", "m", "static", "api"]);
    if (subdomain && !reserved.has(subdomain)) {
      return subdomain;
    }
  }

  const seg = url.pathname.split("/").filter(Boolean);
  const userFromPath = seg[0];
  if (host === "pixnet.net" && userFromPath) {
    const reservedPaths = new Set([
      "blog",
      "mainpage",
      "album",
      "forum",
      "user",
      "about",
      "help",
      "search"
    ]);
    if (!reservedPaths.has(String(userFromPath).toLowerCase())) {
      return userFromPath;
    }
  }

  throw new Error("Cannot infer PIXNET user from URL. Use a PIXNET blog URL like https://{user}.pixnet.net/.");
}

function extractPixnetArticles(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.articles)) return payload.articles;
  if (Array.isArray(payload?.data?.articles)) return payload.data.articles;
  return [];
}

function normalizePixnetTag(rawTag) {
  if (typeof rawTag === "string") return rawTag;
  if (rawTag && typeof rawTag === "object") {
    return rawTag.tag || rawTag.name || rawTag.title || "";
  }
  return "";
}

function mapPixnetArticleToWordPressRaw(article) {
  const tags = Array.isArray(article?.tags) ? article.tags.map(normalizePixnetTag).filter(Boolean) : [];
  const categories = Array.isArray(article?.categories)
    ? article.categories.map(normalizePixnetTag).filter(Boolean)
    : [];

  return {
    title: article?.title ?? article?.name ?? "Untitled",
    content:
      article?.body ??
      article?.article ??
      article?.content ??
      article?.description ??
      article?.summary ??
      "",
    date: article?.public_at ?? article?.date ?? article?.created_at ?? article?.post_date ?? null,
    URL: article?.link ?? article?.url ?? article?.site_category?.link ?? null,
    categories,
    tags
  };
}

async function fetchPixnetByEndpoint(endpointBase, user, fetchImpl) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({
      user,
      page: String(page),
      per_page: String(PAGE_SIZE),
      format: "json"
    });
    const requestUrl = `${endpointBase}?${params.toString()}`;
    const res = await fetchImpl(requestUrl);
    if (!res.ok) {
      if ((res.status === 400 || res.status === 404) && page === 1) {
        return null;
      }
      if (res.status === 400 || res.status === 404) break;
      throw new Error(`PIXNET API request failed (${res.status}) at ${endpointBase}`);
    }

    const raw = await res.text();
    const body = parseJsonSafe(raw);
    if (!body) {
      throw new Error(`PIXNET API returned non-JSON payload at ${endpointBase}`);
    }

    const articles = extractPixnetArticles(body);
    if (!Array.isArray(articles) || articles.length === 0) break;
    items.push(...articles);
    if (articles.length < PAGE_SIZE) break;
  }
  return items;
}

export async function fetchPixnetByUrl(inputUrl, fetchImpl = fetch) {
  const user = parsePixnetIdentity(inputUrl);
  const endpoints = [
    "https://emma.pixnet.cc/blog/articles",
    "https://emma.pixnet.cc/mainpage/blog/articles"
  ];

  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const articles = await fetchPixnetByEndpoint(endpoint, user, fetchImpl);
      if (articles === null) continue;
      if (!articles.length) continue;
      return normalizeWordPressData({
        posts: articles.map(mapPixnetArticleToWordPressRaw)
      });
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw new Error(`Unable to fetch PIXNET data from URL: ${lastError.message}`);
  }
  throw new Error("Unable to fetch PIXNET data from URL: no public articles found.");
}

export async function fetchByUrl(inputUrl, platformInput = "auto", fetchImpl = fetch) {
  const platform = detectPlatformByUrl(inputUrl, platformInput);
  if (platform === "pixnet") {
    return fetchPixnetByUrl(inputUrl, fetchImpl);
  }
  return fetchWordPressByUrl(inputUrl, fetchImpl);
}
