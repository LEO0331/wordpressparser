import { normalizeWordPressData } from "./parser.js";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

const MAX_PAGES = 20;
const PAGE_SIZE = 100;
const PLATFORM_VALUES = new Set(["auto", "wordpress", "pixnet"]);
const MAX_REDIRECTS = 5;
const EXTRACTION_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_EXTRACTION_BYTES = 48 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const nonPublicIPv4 = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
]) {
  nonPublicIPv4.addSubnet(address, prefix);
}

const globalIPv6 = new net.BlockList();
globalIPv6.addSubnet("2000::", 3, "ipv6");
const nonPublicIPv6 = new net.BlockList();
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]]) {
  nonPublicIPv6.addSubnet(address, prefix, "ipv6");
}

const decoders = new Map([
  ["gzip", createGunzip],
  ["deflate", createInflate],
  ["br", createBrotliDecompress]
]);

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
  if (url.username || url.password) {
    throw new Error("URL credentials are not supported.");
  }
  return {
    baseUrl: `${url.protocol}//${url.host}`,
    host: url.host,
    hostname: url.hostname
  };
}

async function resolvePublicAddresses(inputUrl, resolver) {
  const { hostname } = sanitizeSiteUrl(inputUrl);
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const rootlessHost = host.replace(/\.$/, "");
  if (rootlessHost === "localhost" || rootlessHost.endsWith(".localhost")) {
    throw new Error("Target host is not allowed.");
  }

  const records = net.isIP(host)
    ? [{ address: host }]
    : await resolver(host, { all: true, verbatim: true });
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("No DNS records found for host.");
  }
  return records.map(({ address }) => {
    const family = net.isIP(address);
    const isPublic = family === 4
      ? !nonPublicIPv4.check(address)
      : family === 6 && globalIPv6.check(address, "ipv6") && !nonPublicIPv6.check(address, "ipv6");
    if (!isPublic) {
      throw new Error("Target host resolves to a private or local network address.");
    }
    return { address, family };
  });
}

export async function assertSafeExtractionTarget(inputUrl, resolver = dns.lookup) {
  await resolvePublicAddresses(inputUrl, resolver);
}

async function withDeadline(operation, signal) {
  signal.throwIfAborted();
  let abort;
  const deadline = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation(), deadline]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function readResponse(response, signal, remainingBytes) {
  const limit = Math.min(MAX_RESPONSE_BYTES, remainingBytes);
  const tooLarge = () => new Error("URL extraction response exceeds the size limit.");
  if (Number(response.headers["content-length"]) > limit) {
    response.destroy();
    throw tooLarge();
  }
  const encoding = String(response.headers["content-encoding"] || "identity").trim().toLowerCase();
  const decoder = decoders.get(encoding);
  if (encoding !== "identity" && !decoder) {
    response.destroy();
    throw new Error("URL extraction response uses unsupported compression.");
  }
  const chunks = [];
  let size = 0;
  const streams = [response];
  let wireBytes = 0;
  if (decoder) {
    streams.push(new Transform({
      transform(chunk, _encoding, callback) {
        wireBytes += chunk.length;
        callback(wireBytes > limit ? tooLarge() : null, chunk);
      }
    }), decoder());
  }
  await pipeline(...streams, async (source) => {
    for await (const chunk of source) {
      size += chunk.length;
      if (size > limit) throw tooLarge();
      chunks.push(chunk);
    }
  }, { signal });
  return { body: Buffer.concat(chunks, size), bytes: Math.max(size, wireBytes) };
}

async function requestExtractionPage(url, { lookup, signal, remainingBytes }) {
  const client = url.protocol === "https:" ? https : http;
  // Keep the URL hostname for Host, TLS SNI, and certificate checks.
  const response = await new Promise((resolve, reject) => {
    client.get(url, {
      lookup,
      signal,
      agent: false,
      autoSelectFamily: true,
      headers: {
        Accept: "*/*",
        "Accept-Encoding": "gzip, deflate, br",
        "User-Agent": "wordpress-parser"
      }
    }, resolve).once("error", reject);
  });
  const status = response.statusCode;
  const ok = status >= 200 && status < 300;
  const headers = { get: (header) => response.headers[header] };
  if (!ok) {
    response.destroy();
    return { status, ok, headers };
  }
  const { body, bytes } = await readResponse(response, signal, remainingBytes);
  return {
    status,
    ok,
    headers,
    bytes,
    text: async () => body.toString("utf8"),
    json: async () => JSON.parse(body.toString("utf8"))
  };
}

function createExtractionFetcher(fetchImpl, resolver = dns.lookup) {
  const signal = AbortSignal.timeout(EXTRACTION_TIMEOUT_MS);
  const hosts = new Map();
  let remainingBytes = MAX_EXTRACTION_BYTES;

  async function validate(url) {
    const { hostname } = sanitizeSiteUrl(url);
    if (!hosts.has(hostname)) {
      hosts.set(hostname, withDeadline(() => resolvePublicAddresses(url, resolver), signal));
    }
    return hosts.get(hostname);
  }

  async function fetchPage(input) {
    let url = new URL(input);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      signal.throwIfAborted();
      if (remainingBytes <= 0) {
        throw new Error("URL extraction exceeded its total response size limit.");
      }
      const addresses = await validate(url);
      const lookup = (_hostname, options, callback) => {
        const family = Number(options.family) || 0;
        const matching = family ? addresses.filter((record) => record.family === family) : addresses;
        if (!matching.length) return callback(new Error("No validated address for this connection."));
        if (options.all) return callback(null, matching);
        return callback(null, matching[0].address, matching[0].family);
      };
      const res = fetchImpl
        ? await fetchImpl(url.href, { redirect: "manual", lookup, signal })
        : await requestExtractionPage(url, { lookup, signal, remainingBytes });
      remainingBytes -= res.bytes ?? 0;
      if (!REDIRECT_STATUSES.has(res.status)) return res;

      const location = res.headers?.get("location");
      if (hop === MAX_REDIRECTS || !location) {
        throw new Error("URL extraction encountered an invalid redirect chain.");
      }
      url = new URL(location, url);
    }
  }
  return { fetchPage, validate };
}

export function normalizePlatform(platformInput) {
  const normalized = String(platformInput || "auto").trim().toLowerCase();
  return PLATFORM_VALUES.has(normalized) ? normalized : "auto";
}

export function detectPlatformByUrl(inputUrl, platformInput = "auto") {
  const forced = normalizePlatform(platformInput);
  if (forced !== "auto") return forced;
  const { hostname } = sanitizeSiteUrl(inputUrl);
  if (hostname.endsWith(".pixnet.net") || hostname.endsWith(".pixnet.cc") || hostname === "pixnet.net") {
    return "pixnet";
  }
  return "wordpress";
}

export async function fetchWpRestItems(baseUrl, endpoint, fetchImpl = createExtractionFetcher().fetchPage) {
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
    results.push(...body.slice(0, PAGE_SIZE));
    if (body.length < PAGE_SIZE) break;
  }
  return results;
}

export async function fetchWpComItems(host, postType = "post", fetchImpl = createExtractionFetcher().fetchPage) {
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
    items.push(...posts.slice(0, PAGE_SIZE));
    if (posts.length < PAGE_SIZE) break;
  }
  return items;
}

export async function fetchWordPressByUrl(inputUrl, fetchImpl, resolver) {
  const { fetchPage, validate } = createExtractionFetcher(fetchImpl, resolver);
  await validate(inputUrl);
  const { baseUrl, hostname } = sanitizeSiteUrl(inputUrl);
  let posts = [];
  let pages = [];
  let wpV2Error = null;

  try {
    posts = await fetchWpRestItems(baseUrl, "posts", fetchPage);
    pages = await fetchWpRestItems(baseUrl, "pages", fetchPage);
  } catch (error) {
    wpV2Error = error;
  }

  if (posts.length === 0 && pages.length === 0) {
    const wpcomPosts = await fetchWpComItems(hostname, "post", fetchPage);
    const wpcomPages = await fetchWpComItems(hostname, "page", fetchPage);
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
  const { hostname } = sanitizeSiteUrl(inputUrl);
  const url = new URL(inputUrl);
  const queryUser = String(url.searchParams.get("user") || "").trim();
  if (queryUser) return queryUser;

  if (hostname.endsWith(".pixnet.net")) {
    const subdomain = hostname.slice(0, -".pixnet.net".length);
    const reserved = new Set(["www", "m", "static", "api"]);
    if (subdomain && !reserved.has(subdomain)) {
      return subdomain;
    }
  }

  const seg = url.pathname.split("/").filter(Boolean);
  const userFromPath = seg[0];
  if (hostname === "pixnet.net" && userFromPath) {
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
    items.push(...articles.slice(0, PAGE_SIZE));
    if (articles.length < PAGE_SIZE) break;
  }
  return items;
}

export async function fetchPixnetByUrl(inputUrl, fetchImpl, resolver) {
  const user = parsePixnetIdentity(inputUrl);
  const { fetchPage } = createExtractionFetcher(fetchImpl, resolver);
  const endpoints = [
    "https://emma.pixnet.cc/blog/articles",
    "https://emma.pixnet.cc/mainpage/blog/articles"
  ];

  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const articles = await fetchPixnetByEndpoint(endpoint, user, fetchPage);
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

export async function fetchByUrl(inputUrl, platformInput = "auto", fetchImpl, resolver) {
  const platform = detectPlatformByUrl(inputUrl, platformInput);
  if (platform === "pixnet") {
    return fetchPixnetByUrl(inputUrl, fetchImpl, resolver);
  }
  return fetchWordPressByUrl(inputUrl, fetchImpl, resolver);
}
