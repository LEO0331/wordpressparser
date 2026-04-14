import { loadMcpConfig } from "./config.js";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";
import { WordPressClient } from "./wp-client.js";

const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

export function resolveMaxMessageBytes(value, fallback = DEFAULT_MAX_MESSAGE_BYTES) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

const MAX_MESSAGE_BYTES = resolveMaxMessageBytes(process.env.MCP_MAX_MESSAGE_BYTES);

export class StdioMessageReader {
  constructor(onMessage, onProtocolError, maxMessageBytes = MAX_MESSAGE_BYTES) {
    this.onMessage = onMessage;
    this.onProtocolError = onProtocolError;
    this.maxMessageBytes = maxMessageBytes;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.maxMessageBytes) {
      this.onProtocolError(new Error("MCP message exceeds max allowed size."));
      this.buffer = Buffer.alloc(0);
      return;
    }

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;

      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const lines = header.split("\r\n");
      const contentLengthLine = lines.find((x) => x.toLowerCase().startsWith("content-length:"));
      if (!contentLengthLine) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      const contentLength = Number(contentLengthLine.split(":")[1].trim());
      if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > this.maxMessageBytes) {
        this.onProtocolError(new Error("Invalid or oversized Content-Length."));
        this.buffer = Buffer.alloc(0);
        return;
      }

      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (this.buffer.length < messageEnd) return;

      const body = this.buffer.slice(messageStart, messageEnd).toString("utf8");
      this.buffer = this.buffer.slice(messageEnd);

      try {
        const parsed = JSON.parse(body);
        this.onMessage(parsed);
      } catch {
        // Ignore malformed payload.
      }
    }
  }
}

class StdioMessageWriter {
  send(message) {
    const body = JSON.stringify(message);
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }
}

function success(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function failure(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, data }
  };
}

function createServerContext() {
  const config = loadMcpConfig();
  const client = new WordPressClient({
    baseUrl: config.baseUrl,
    username: config.username,
    appPassword: config.appPassword,
    preferredVersion: config.preferredVersion,
    timeoutMs: config.timeoutMs
  });
  return { config, client };
}

async function handleRequest(req, writer, context) {
  const { id, method, params } = req;

  try {
    if (method === "initialize") {
      writer.send(
        success(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: "wordpress-mcp-sidecar",
            version: "0.1.0"
          }
        })
      );
      return;
    }

    if (method === "notifications/initialized") {
      return;
    }

    if (method === "ping") {
      writer.send(success(id, {}));
      return;
    }

    if (method === "tools/list") {
      writer.send(
        success(id, {
          tools: TOOL_DEFINITIONS
        })
      );
      return;
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments || {};
      const output = await executeTool(toolName, args, context);
      writer.send(success(id, output));
      return;
    }

    writer.send(failure(id, -32601, `Method not found: ${method}`));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writer.send(
      failure(id, -32000, message, {
        stack: process.env.NODE_ENV === "development" && error instanceof Error ? error.stack : undefined
      })
    );
  }
}

function main() {
  const writer = new StdioMessageWriter();
  const context = createServerContext();
  const reader = new StdioMessageReader(
    (message) => {
      if (message?.jsonrpc !== "2.0") return;
      if (typeof message.id === "undefined") return;
      handleRequest(message, writer, context);
    },
    (error) => {
      writer.send(
        failure(null, -32700, error.message, {
          limit: MAX_MESSAGE_BYTES
        })
      );
    }
  );

  process.stdin.on("data", (chunk) => reader.push(chunk));
  process.stdin.on("error", () => process.exit(1));
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  main();
}
