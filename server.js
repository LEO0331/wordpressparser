import express from "express";
import { normalizeWordPressData } from "./src/parser.js";
import { generateArtifacts } from "./src/generator.js";

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(express.json({ limit: "15mb" }));
app.use(express.static("public"));

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
      // WordPress uses 400 for "invalid page number" when page exceeds bounds.
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

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.post("/api/normalize", (req, res) => {
  try {
    const items = normalizeWordPressData(req.body?.data);
    res.json({
      items,
      metadata: {
        itemCount: items.length
      }
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/extract-url", async (req, res) => {
  try {
    const url = req.body?.url;
    if (!url) {
      return res.status(400).json({ error: "Missing url" });
    }

    const items = await fetchWordPressByUrl(url);
    res.json({
      items,
      metadata: {
        itemCount: items.length
      }
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
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

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`wordpress-parser running at http://localhost:${port}`);
});
