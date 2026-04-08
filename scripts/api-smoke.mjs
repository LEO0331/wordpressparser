const base = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3000";

async function request(path, options = {}) {
  const res = await fetch(`${base}${path}`, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function main() {
  const health = await request("/api/health");
  if (!health.ok) throw new Error("Health response missing ok=true");

  const normalize = await request("/api/normalize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      data: {
        posts: [
          {
            title: "Smoke Post",
            content: "<p>A short parser smoke test body</p>",
            date: "2026-04-08",
            URL: "https://example.com/post"
          }
        ]
      }
    })
  });
  if (!Array.isArray(normalize.items) || normalize.items.length !== 1) {
    throw new Error("Normalize did not return expected items.");
  }

  const build = await request("/api/build", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      slug: "ci-smoke",
      name: "CI Smoke",
      items: normalize.items,
      options: {
        language: "en",
        mode: "parser"
      }
    })
  });
  if (typeof build.skillMarkdown !== "string" || !build.skillMarkdown.includes("PART A")) {
    throw new Error("Build output missing expected skill markdown.");
  }

  // eslint-disable-next-line no-console
  console.log("API smoke test passed.");
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error.message);
  process.exit(1);
});
