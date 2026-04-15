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
