import test from "node:test";
import assert from "node:assert/strict";
import { StdioMessageReader, resolveMaxMessageBytes } from "../mcp/server.js";

function frame(json) {
  const body = JSON.stringify(json);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

test("resolveMaxMessageBytes falls back for invalid values", () => {
  assert.equal(resolveMaxMessageBytes("abc", 123), 123);
  assert.equal(resolveMaxMessageBytes("0", 123), 123);
  assert.equal(resolveMaxMessageBytes("-10", 123), 123);
  assert.equal(resolveMaxMessageBytes("2048", 123), 2048);
});

test("StdioMessageReader parses partial chunked frame", () => {
  const received = [];
  const errors = [];
  const reader = new StdioMessageReader(
    (msg) => received.push(msg),
    (err) => errors.push(err.message),
    4096
  );

  const raw = frame({ jsonrpc: "2.0", id: 1, method: "ping" });
  reader.push(Buffer.from(raw.slice(0, 20), "utf8"));
  reader.push(Buffer.from(raw.slice(20), "utf8"));

  assert.equal(errors.length, 0);
  assert.equal(received.length, 1);
  assert.equal(received[0].method, "ping");
});

test("StdioMessageReader rejects oversized content-length", () => {
  const errors = [];
  const reader = new StdioMessageReader(
    () => {},
    (err) => errors.push(err.message),
    200
  );

  const payload = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
  const raw = `Content-Length: 999\r\n\r\n${payload}`;
  reader.push(Buffer.from(raw, "utf8"));

  assert.ok(errors.some((x) => x.includes("Invalid or oversized Content-Length")));
});

test("StdioMessageReader rejects oversized buffer growth", () => {
  const errors = [];
  const reader = new StdioMessageReader(
    () => {},
    (err) => errors.push(err.message),
    16
  );

  reader.push(Buffer.from("x".repeat(17), "utf8"));
  assert.ok(errors.some((x) => x.includes("exceeds max allowed size")));
});
