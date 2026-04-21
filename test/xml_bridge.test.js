import test from "node:test";
import assert from "node:assert/strict";
import {
  buildObsidianMarkdown,
  convertWordPressXmlToObsidian,
  parseMultipartXmlUpload,
  parseWordPressXml
} from "../src/xml_bridge.js";

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <item>
      <title>Hello 😀 Post</title>
      <link>https://example.com/hello</link>
      <pubDate>Tue, 14 Apr 2026 12:00:00 +0000</pubDate>
      <content:encoded><![CDATA[
        <p>Hi <a href="https://example.com/about">about</a> and emoji 😀</p>
        <p><img src="https://example.com/cat.png" alt="cat" /></p>
      ]]></content:encoded>
      <wp:post_id>101</wp:post_id>
      <wp:post_date>2026-04-14 12:00:00</wp:post_date>
      <wp:post_modified>2026-04-15 12:00:00</wp:post_modified>
      <wp:post_name>hello-post</wp:post_name>
      <wp:status>publish</wp:status>
      <wp:post_type>post</wp:post_type>
      <category domain="category" nicename="updates"><![CDATA[Updates]]></category>
      <category domain="post_tag" nicename="emoji"><![CDATA[emoji]]></category>
    </item>
    <item>
      <title>Attachment</title>
      <wp:post_type>attachment</wp:post_type>
      <content:encoded><![CDATA[<p>ignore</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;

const MALICIOUS_URL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <item>
      <title>Bad URL</title>
      <link>javascript:alert(1)</link>
      <content:encoded><![CDATA[
        <p><a href="javascript:alert(1)">X</a></p>
        <p><img src="data:text/html,boom" alt="bad" /></p>
      ]]></content:encoded>
      <wp:post_id>102</wp:post_id>
      <wp:post_date>2026-04-14 12:00:00</wp:post_date>
      <wp:post_name>bad-url</wp:post_name>
      <wp:status>publish</wp:status>
      <wp:post_type>post</wp:post_type>
    </item>
  </channel>
</rss>`;

test("parseWordPressXml normalizes WXR items", () => {
  const items = parseWordPressXml(SAMPLE_XML);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Hello 😀 Post");
  assert.equal(items[0].type, "post");
  assert.ok(items[0].content.includes("[about](https://example.com/about)"));
  assert.ok(items[0].content.includes("![cat](https://example.com/cat.png)"));
  assert.deepEqual(items[0].categories, ["Updates"]);
  assert.deepEqual(items[0].tags, ["emoji"]);
});

test("parseWordPressXml strips unsafe markdown protocols", () => {
  const items = parseWordPressXml(MALICIOUS_URL_XML);
  assert.equal(items.length, 1);
  assert.equal(items[0].source_url, "");
  assert.equal(items[0].url, "");
  assert.ok(!items[0].content.includes("javascript:"));
  assert.ok(!items[0].content.includes("data:text"));
});

test("parseWordPressXml escapes markdown-link-unsafe URL characters", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <item>
      <title>Escaping</title>
      <content:encoded><![CDATA[
        <p><a href="https://example.com/a path(test)">go</a></p>
        <p><img src="https://example.com/media (1).png" alt="img" /></p>
      ]]></content:encoded>
      <wp:post_id>103</wp:post_id>
      <wp:post_date>2026-04-14 12:00:00</wp:post_date>
      <wp:post_name>escaping</wp:post_name>
      <wp:status>publish</wp:status>
      <wp:post_type>post</wp:post_type>
    </item>
  </channel>
</rss>`;
  const items = parseWordPressXml(xml);
  assert.equal(items.length, 1);
  assert.ok(items[0].content.includes("[go](https://example.com/a%20path%28test%29)"));
  assert.ok(items[0].content.includes("![img](https://example.com/media%20%281%29.png)"));
});

test("buildObsidianMarkdown includes frontmatter fields", () => {
  const output = buildObsidianMarkdown({
    title: "Hello",
    slug: "hello",
    date: "2026-04-14",
    updated: "2026-04-15",
    status: "publish",
    type: "post",
    categories: ["Updates"],
    tags: ["tag1"],
    source_url: "https://example.com/hello",
    wordpress_id: "101",
    content: "Body"
  });

  assert.ok(output.startsWith("---\n"));
  assert.ok(output.includes("title: \"Hello\""));
  assert.ok(output.includes("categories:\n  - \"Updates\""));
  assert.ok(output.includes("wordpress_id: \"101\""));
  assert.ok(output.endsWith("Body\n"));
});

test("buildObsidianMarkdown frontmatter escapes newlines", () => {
  const output = buildObsidianMarkdown({
    title: "Line 1\nLine 2",
    slug: "hello",
    date: "2026-04-14",
    updated: "",
    status: "publish",
    type: "post",
    categories: [],
    tags: [],
    source_url: "",
    wordpress_id: "1",
    content: "Body"
  });
  assert.ok(output.includes("title: \"Line 1 Line 2\""));
});

test("convertWordPressXmlToObsidian returns zip + report and skips unsupported types", () => {
  const result = convertWordPressXmlToObsidian(SAMPLE_XML);
  assert.ok(Buffer.isBuffer(result.zipBuffer));
  assert.equal(result.zipBuffer.subarray(0, 2).toString("utf8"), "PK");
  assert.equal(result.metadata.totalItems, 2);
  assert.equal(result.metadata.convertedItems, 1);
  assert.equal(result.metadata.skippedItems, 1);
  assert.ok(result.metadata.warningCount >= 1);
});

test("parseMultipartXmlUpload validates payload and extracts xml", () => {
  const boundary = "----WebKitFormBoundaryXYZ";
  const body = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="export.xml"\r\n` +
    "Content-Type: text/xml\r\n\r\n" +
    SAMPLE_XML +
    `\r\n--${boundary}--\r\n`
  );

  const xml = parseMultipartXmlUpload(body, `multipart/form-data; boundary=${boundary}`);
  assert.ok(xml.includes("<rss version="));

  assert.throws(
    () => parseMultipartXmlUpload(body, "text/plain"),
    /Unsupported upload format/
  );
});

test("parseWordPressXml throws invalid_xml code for malformed xml", () => {
  assert.throws(() => parseWordPressXml("not xml"), (error) => error.code === "invalid_xml");
});
