import test from "node:test";
import assert from "node:assert/strict";
import { createServerContext, handleRequest, main } from "../mcp/server.js";

function createWriter() {
  const sent = [];
  return {
    sent,
    send(payload) {
      sent.push(payload);
    }
  };
}

test("createServerContext builds config and client", () => {
  const old = {
    WP_BASE_URL: process.env.WP_BASE_URL,
    WP_USERNAME: process.env.WP_USERNAME,
    WP_APP_PASSWORD: process.env.WP_APP_PASSWORD
  };
  process.env.WP_BASE_URL = "https://example.com";
  process.env.WP_USERNAME = "u";
  process.env.WP_APP_PASSWORD = "p";
  try {
    const ctx = createServerContext();
    assert.equal(ctx.config.baseUrl, "https://example.com");
    assert.equal(typeof ctx.client.listPosts, "function");
  } finally {
    if (old.WP_BASE_URL === undefined) delete process.env.WP_BASE_URL;
    else process.env.WP_BASE_URL = old.WP_BASE_URL;
    if (old.WP_USERNAME === undefined) delete process.env.WP_USERNAME;
    else process.env.WP_USERNAME = old.WP_USERNAME;
    if (old.WP_APP_PASSWORD === undefined) delete process.env.WP_APP_PASSWORD;
    else process.env.WP_APP_PASSWORD = old.WP_APP_PASSWORD;
  }
});

test("handleRequest supports initialize/ping/tools-list/method-not-found", async () => {
  const writer = createWriter();
  const context = createServerContext();

  await handleRequest({ id: 1, method: "initialize", params: {} }, writer, context);
  await handleRequest({ id: 2, method: "ping", params: {} }, writer, context);
  await handleRequest({ id: 3, method: "tools/list", params: {} }, writer, context);
  await handleRequest({ id: 4, method: "unknown/method", params: {} }, writer, context);
  await handleRequest({ id: 5, method: "notifications/initialized", params: {} }, writer, context);

  assert.equal(writer.sent[0].result.serverInfo.name, "wordpress-mcp-sidecar");
  assert.deepEqual(writer.sent[1].result, {});
  assert.ok(Array.isArray(writer.sent[2].result.tools));
  assert.equal(writer.sent[3].error.code, -32601);
  assert.equal(writer.sent.length, 4);
});

test("handleRequest executes tools/call and wraps thrown errors", async () => {
  const writer = createWriter();
  const context = {
    config: {
      baseUrl: "https://example.com",
      username: "u",
      appPassword: "p"
    },
    client: {
      listPosts: async () => ({ posts: [{ id: 1 }] })
    }
  };
  await handleRequest(
    { id: 1, method: "tools/call", params: { name: "list_wp_posts", arguments: {} } },
    writer,
    context
  );
  assert.equal(writer.sent[0].result.structuredContent.posts[0].id, 1);

  const errorWriter = createWriter();
  const oldNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    await handleRequest(
      { id: 2, method: "tools/call", params: { name: "list_wp_posts", arguments: {} } },
      errorWriter,
      {
        config: { baseUrl: "", username: "", appPassword: "" },
        client: {}
      }
    );
  } finally {
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
  }

  assert.equal(errorWriter.sent[0].error.code, -32000);
  assert.ok(String(errorWriter.sent[0].error.data?.stack || "").includes("Error"));
});

test("main wires stdin listeners and responds to framed ping", async () => {
  const oldOn = process.stdin.on;
  const oldWrite = process.stdout.write;
  const handlers = {};
  let written = "";

  process.stdin.on = (event, fn) => {
    handlers[event] = fn;
    return process.stdin;
  };
  process.stdout.write = (chunk) => {
    written += String(chunk);
    return true;
  };

  try {
    main();
    assert.equal(typeof handlers.data, "function");
    assert.equal(typeof handlers.error, "function");

    const body = JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping", params: {} });
    const framed = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
    handlers.data(Buffer.from(framed, "utf8"));

    assert.ok(written.includes("Content-Length:"));
    assert.ok(written.includes('"id":99'));
  } finally {
    process.stdin.on = oldOn;
    process.stdout.write = oldWrite;
  }
});
