import assert from "node:assert/strict";
import { test } from "node:test";
import Linq from "@linqapp/sdk";
import { ApplicationFailure } from "@temporalio/common";
import { createLinqActivities } from "./linq";

test("outbound sends target the original chat with a stable idempotency key", async () => {
  const requests: Request[] = [];
  const client = new Linq({
    apiKey: "test-key",
    maxRetries: 0,
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return new Response("{}", {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const activities = createLinqActivities("test-key", client);
  const input = {
    chatId: "chat-123",
    messageId: "incoming-123",
    text: "Hello back",
  };
  await activities.sendLinqReply(input);
  await activities.sendLinqReply(input);
  for (const request of requests) {
    assert.equal(
      request.url,
      "https://api.linqapp.com/api/partner/v3/chats/chat-123/messages",
    );
    assert.equal(request.headers.get("Authorization"), "Bearer test-key");
    assert.deepEqual(await request.json(), {
      message: {
        parts: [{ type: "text", value: "Hello back" }],
        idempotency_key: "beatrice:incoming-123",
      },
    });
  }
});

test("permanent errors stop retries; rate limits and server errors remain retryable", async () => {
  for (const status of [401, 403, 408, 429, 500]) {
    const client = new Linq({
      apiKey: "test-key",
      maxRetries: 0,
      fetch: async () =>
        new Response('{"error":"private-provider-details"}', { status }),
    });
    const activities = createLinqActivities("test-key", client);
    await assert.rejects(
      activities.sendLinqReply({
        chatId: "chat",
        messageId: "message",
        text: "Hello",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ApplicationFailure);
        assert.equal(error.nonRetryable, status === 401 || status === 403);
        assert.ok(!error.message.includes("private-provider-details"));
        return true;
      },
    );
  }
});
