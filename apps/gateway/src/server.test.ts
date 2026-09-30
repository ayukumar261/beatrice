import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { LinqIncomingMessage } from "@repo/types";
import type { Config } from "./config";
import { createLinqServer } from "./server";

const config: Config = {
  apiKey: "test-key",
  webhookSecret: `whsec_${Buffer.from("test-signing-secret-only").toString("base64")}`,
  phoneNumber: "+15550000001",
  allowedNumbers: ["+15550000002"],
  host: "127.0.0.1",
  port: 3001,
  temporalAddress: "localhost:7233",
};

function event(messageId = "message-1", text = "Hello") {
  return {
    api_version: "v3",
    webhook_version: "2026-02-03",
    event_type: "message.received",
    event_id: `event-${messageId}`,
    created_at: new Date().toISOString(),
    data: {
      id: messageId,
      direction: "inbound",
      service: "SMS",
      chat: {
        id: "chat-1",
        is_group: false,
        owner_handle: { handle: config.phoneNumber, is_me: true },
        health_status: { status: "HEALTHY" },
      },
      sender_handle: { handle: config.allowedNumbers[0]!, is_me: false },
      parts: [{ type: "text", value: text }],
    },
  };
}

function signedHeaders(body: string, seconds = Math.floor(Date.now() / 1000)) {
  const signature = createHmac(
    "sha256",
    Buffer.from(config.webhookSecret.slice(6), "base64"),
  )
    .update(`delivery-1.${seconds}.${body}`)
    .digest("base64");
  return {
    "Content-Type": "application/json",
    "webhook-id": "delivery-1",
    "webhook-timestamp": String(seconds),
    "webhook-signature": `v1,${signature}`,
  };
}

test("signed HTTP webhooks validate, filter and wait for durable acceptance", async (t) => {
  const received: LinqIncomingMessage[] = [];
  let fail = false;
  const server = createLinqServer(config, async (message) => {
    if (fail) throw new Error("Temporal unavailable");
    received.push(message);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/linq?version=2026-02-03`;
  async function post(value: unknown, headers?: Record<string, string>) {
    const body = JSON.stringify(value);
    const result = await fetch(url, {
      method: "POST",
      body,
      headers: headers ?? signedHeaders(body),
    });
    await result.text();
    return result.status;
  }
  assert.equal(await post(event()), 200);
  assert.equal(received.length, 1);
  assert.equal(received[0]?.text, "Hello");
  const body = JSON.stringify(event());
  assert.equal(await post(event(), {}), 401);
  assert.equal(
    await post(
      event(),
      signedHeaders(body, Math.floor(Date.now() / 1000) - 600),
    ),
    401,
  );
  assert.equal(
    await post(
      event(),
      signedHeaders(body, Math.floor(Date.now() / 1000) + 600),
    ),
    401,
  );
  assert.equal(await post(event("tampered"), signedHeaders(body)), 401);
  const stranger = event();
  stranger.data.sender_handle.handle = "+15550000003";
  const otherLine = event();
  otherLine.data.chat.owner_handle.handle = "+15550000004";
  const group = event();
  group.data.chat.is_group = true;
  const outbound = event();
  outbound.data.direction = "outbound";
  const sent = event();
  sent.event_type = "message.sent";
  const optedOut = event();
  optedOut.data.chat.health_status.status = "OPTED_OUT";
  const recovered = {
    ...event(),
    data: { ...event().data, reconciled_at: new Date().toISOString() },
  };
  for (const ignored of [
    stranger,
    otherLine,
    group,
    outbound,
    sent,
    optedOut,
    recovered,
  ])
    assert.equal(await post(ignored), 200);
  assert.equal(received.length, 1);
  assert.equal(await post({ ...event(), data: {} }), 400);
  assert.equal(await post({ ...event(), webhook_version: "2025-01-01" }), 400);
  const media = event();
  media.data.parts = [{ type: "media", value: "" }];
  assert.equal(await post(media), 200);
  assert.equal(received[1]?.hasAttachments, true);
  assert.equal(received[1]?.text, "");
  assert.equal(await post(event("huge", "a".repeat(270_000))), 413);
  fail = true;
  assert.equal(await post(event("retry-me")), 503);
  assert.equal(received.length, 2);
});
