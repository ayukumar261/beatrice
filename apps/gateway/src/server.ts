import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import Linq from "@linqapp/sdk";
import type { LinqIncomingMessage } from "@repo/types";

import type { Config } from "./config";
import { parseInboundEvent } from "./events";

const MAX_BODY_BYTES = 256 * 1024;

export function createLinqServer(
  config: Config,
  enqueue: (message: LinqIncomingMessage) => Promise<void>,
) {
  const linq = new Linq({
    apiKey: config.apiKey,
    webhookSecret: config.webhookSecret,
  });
  return createServer(
    { requestTimeout: 10_000, headersTimeout: 10_000 },
    (req, res) => {
      void handle(req, res).catch(() => {
        // Do not log message bodies or signature headers.
        console.error(
          "Linq webhook could not be queued; returning 503 for retry",
        );
        if (!res.headersSent) res.writeHead(503).end();
        else res.end();
      });
    },
  );

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET" && path === "/healthz") {
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end('{"ok":true}');
      return;
    }
    if (req.method !== "POST" || path !== "/webhooks/linq") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413, { Connection: "close" }).end();
        return;
      }
      chunks.push(bytes);
    }
    const headers: Record<string, string> = {};
    for (const name of [
      "webhook-id",
      "webhook-timestamp",
      "webhook-signature",
    ]) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    let event: unknown;
    try {
      event = linq.webhooks.unwrap(Buffer.concat(chunks).toString("utf8"), {
        headers,
      });
    } catch {
      res.writeHead(401).end();
      return;
    }
    let message: LinqIncomingMessage | null;
    try {
      message = parseInboundEvent(event, config);
    } catch {
      res.writeHead(400).end();
      return;
    }
    // Acknowledge only after Temporal durably accepts the signal.
    if (message) await enqueue(message);
    res.writeHead(200).end();
  }
}
