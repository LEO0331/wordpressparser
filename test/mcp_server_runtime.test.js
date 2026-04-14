import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

function frame(payload) {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function readFramedMessage(buffer) {
  const text = buffer.toString("utf8");
  const marker = "\r\n\r\n";
  const headerEnd = text.indexOf(marker);
  if (headerEnd < 0) return null;
  const header = text.slice(0, headerEnd);
  const m = header.match(/content-length:\s*(\d+)/i);
  if (!m) return null;
  const len = Number(m[1]);
  const start = headerEnd + marker.length;
  if (buffer.length < start + len) return null;
  const body = buffer.slice(start, start + len).toString("utf8");
  return {
    message: JSON.parse(body),
    rest: buffer.slice(start + len)
  };
}

test("mcp server handles initialize/ping/tools/list/method-not-found", async () => {
  const serverPath = path.resolve(process.cwd(), "mcp/server.js");
  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "test"
    }
  });

  let stdout = Buffer.alloc(0);
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout = Buffer.concat([stdout, chunk]);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "ping", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 4, method: "does/not/exist", params: {} }
  ];
  child.stdin.write(requests.map(frame).join(""));

  const deadline = Date.now() + 3000;
  const received = [];
  while (Date.now() < deadline && received.length < 4) {
    const parsed = readFramedMessage(stdout);
    if (!parsed) {
      await new Promise((r) => setTimeout(r, 20));
      continue;
    }
    received.push(parsed.message);
    stdout = parsed.rest;
  }

  child.kill("SIGTERM");

  assert.equal(received.length, 4);
  assert.equal(received[0].result.serverInfo.name, "wordpress-mcp-sidecar");
  assert.deepEqual(received[1].result, {});
  assert.ok(Array.isArray(received[2].result.tools));
  assert.equal(received[3].error.code, -32601);
  assert.equal(stderr, "");
});
