import { test, expect } from "@playwright/test";

function samplePayload() {
  return {
    posts: [
      {
        title: { rendered: "User Flow Post 1" },
        content: { rendered: "<p>First content with practical guidance.</p>" },
        date: "2026-01-01T00:00:00.000Z",
        link: "https://example.com/flow-1",
        categories: ["ops"],
        tags: ["checklist"]
      },
      {
        title: { rendered: "User Flow Post 2" },
        content: { rendered: "<p>Second content with examples.</p>" },
        date: "2026-02-01T00:00:00.000Z",
        link: "https://example.com/flow-2",
        categories: ["ops"],
        tags: ["examples"]
      }
    ]
  };
}

function sampleXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <item>
      <title>XML Flow Post</title>
      <link>https://example.com/xml-flow-post</link>
      <pubDate>Wed, 17 Apr 2026 08:00:00 +0000</pubDate>
      <content:encoded><![CDATA[<p>XML content for Obsidian export.</p>]]></content:encoded>
      <wp:post_date><![CDATA[2026-04-17 08:00:00]]></wp:post_date>
      <wp:post_type><![CDATA[post]]></wp:post_type>
      <wp:status><![CDATA[publish]]></wp:status>
      <wp:post_name><![CDATA[xml-flow-post]]></wp:post_name>
      <wp:post_id>42</wp:post_id>
      <category domain="category" nicename="notes"><![CDATA[Notes]]></category>
      <category domain="post_tag" nicename="migration"><![CDATA[Migration]]></category>
    </item>
  </channel>
</rss>`;
}

async function openXmlMigration(page) {
  await page.goto("/");
  await page.click("#sourceXmlBtn");
}

async function uploadXmlFile(page, name, content) {
  await page.setInputFiles("#xmlFile", {
    name,
    mimeType: "application/xml",
    buffer: Buffer.from(content, "utf8")
  });
}

test("actual user flow: parse JSON -> generate -> switch output -> save profile", async ({ page }) => {
  const slug = `e2e-${Date.now()}`;
  await page.goto("/");

  await page.fill("#profileSlug", slug);
  await page.fill("#profileName", "E2E User");
  await page.selectOption("#outputMode", "both");
  await page.selectOption("#languageMode", "en");
  await page.selectOption("#generationMode", "parser");
  await page.fill("#jsonText", JSON.stringify(samplePayload(), null, 2));

  await page.click("#parseBtn");
  await expect(page.locator("#status")).toContainText("Parsed 2 items. Ready to generate.");
  await expect(page.locator("#stats")).toContainText("Parsed 2 entries.");

  await page.click("#generateBtn");
  await expect(page.locator("#status")).toContainText("Generation done");
  await expect(page.locator("#output")).toContainText("## PART A");

  await page.click("#tabWiki");
  await expect(page.locator("#output")).toContainText("Wiki");

  await page.click("#saveBtn");
  await expect(page.locator("#status")).toContainText(`Saved profile '${slug}'`);
});

test("processing status shows circle loading icon while parsing", async ({ page }) => {
  await page.route("**/api/normalize", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });

  await page.goto("/");
  await page.fill("#jsonText", JSON.stringify(samplePayload(), null, 2));
  await page.click("#parseBtn");

  await expect(page.locator("#status")).toHaveClass(/is-loading/);
  await expect(page.locator("#status .status-spinner")).toBeVisible();
  await expect(page.locator("#status")).toContainText("Parsing source...");
  await expect(page.locator("#status")).toContainText("Parsed 2 items. Ready to generate.");
  await expect(page.locator("#status")).not.toHaveClass(/is-loading/);
});

test("url mode validation blocks empty URL before request", async ({ page }) => {
  await page.goto("/");
  await page.click("#sourceUrlBtn");
  await page.click("#parseBtn");
  await expect(page.locator("#status")).toContainText("Enter a WordPress or PIXNET URL.");
});

test("xml migration converts a WordPress export and enables zip download", async ({ page }) => {
  await openXmlMigration(page);
  await uploadXmlFile(page, "export.xml", sampleXml());

  await page.click("#parseBtn");

  await expect(page.locator("#status")).toContainText(
    "XML conversion completed. Download the ZIP for Obsidian import."
  );
  await expect(page.locator("#stats")).toContainText("Converted 1/1 items, skipped 0, warnings 0.");
  await expect(page.locator("#downloadXmlBtn")).toBeEnabled();

  const download = page.waitForEvent("download");
  await page.click("#downloadXmlBtn");
  const xmlDownload = await download;
  expect(xmlDownload.suggestedFilename()).toBe("obsidian-export.zip");
});

test("xml migration clears stale zip state after an invalid retry", async ({ page }) => {
  await openXmlMigration(page);
  await uploadXmlFile(page, "export.xml", sampleXml());
  await page.click("#parseBtn");
  await expect(page.locator("#downloadXmlBtn")).toBeEnabled();

  await uploadXmlFile(page, "broken.xml", "not xml");
  await page.click("#parseBtn");

  await expect(page.locator("#status")).toContainText(
    "The uploaded file is not a valid WordPress WXR XML export."
  );
  await expect(page.locator("#downloadXmlBtn")).toBeDisabled();
  await expect(page.locator("#stats")).toHaveClass(/hidden/);
});
