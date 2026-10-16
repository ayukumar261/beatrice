import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { TestContext } from "node:test";
import { Client, Connection } from "@temporalio/client";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
  bundleWorkflowCode,
  NativeConnection,
  Worker,
} from "@temporalio/worker";
import { LINQ_CONVERSATION, LINQ_MESSAGE } from "@repo/types";
import type { LinqIncomingMessage, Message, ToolCall } from "@repo/types";
import type { LinqReply } from "../../services/linq";
import type { GenerateInput } from "../../services/openrouter";
import type { linqConversation } from "./workflow";

test(
  "inbound signal → conversation → reply, including deduplication, memory and recovery",
  { timeout: 60_000 },
  async () => {
    const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
    const connection = await Connection.connect({ address });
    const native = await NativeConnection.connect({ address });
    const client = new Client({ connection });
    const workflowId = `linq-test:${randomUUID()}`;
    const taskQueue = workflowId;
    const generated: GenerateInput[] = [];
    const replies: LinqReply[] = [];
    const traces: string[] = [];
    const toolTraces: string[] = [];
    const worker = await Worker.create({
      connection: native,
      taskQueue,
      workflowsPath: require.resolve("../../workflows"),
      activities: {
        startTrace: async () => {
          const trace = `test-trace-${traces.length}`;
          traces.push(trace);
          return trace;
        },
        generate: async (input: GenerateInput) => {
          generated.push(input);
          const last = input.messages.at(-1);
          if (last?.content === "fail")
            throw ApplicationFailure.nonRetryable("Test LLM failure");
          if (
            last?.content === "search then time" ||
            (last?.role === "tool" && input.step === 1)
          ) {
            const call = {
              id: "call-time",
              type: "function" as const,
              function: { name: "get_time", arguments: '{"timezone":"UTC"}' },
            };
            return {
              message: {
                role: "assistant",
                content: "Search result",
                tool_calls: [call],
              },
              text: "Search result",
              toolCalls: [call],
              webSearchBudgetConsumed: input.step === 0 ? 12 : 38,
            };
          }
          return {
            message: { role: "assistant", content: "Test reply" },
            text: "Test reply",
            toolCalls: [],
          };
        },
        sendLinqReply: async (reply: LinqReply) => {
          replies.push(reply);
        },
        executeTool: async (_call: ToolCall, trace: string) => {
          toolTraces.push(trace);
          return "Test time";
        },
      },
    });
    // Signals exactly as the gateway does once a webhook passes validation.
    async function send(messageId: string, text: string) {
      const message: LinqIncomingMessage = {
        eventId: `event-${messageId}`,
        messageId,
        chatId: "chat-1",
        text,
        hasAttachments: false,
      };
      await client.workflow.signalWithStart(LINQ_CONVERSATION, {
        workflowId,
        taskQueue,
        signal: LINQ_MESSAGE,
        signalArgs: [message],
      });
    }
    async function waitForReplies(count: number, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (replies.length < count && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(replies.length, count);
    }
    try {
      await worker.runUntil(async () => {
        // Concurrent redeliveries must still produce one turn and one reply.
        await Promise.all([
          send("one", "My name is Ada"),
          send("one", "My name is Ada"),
        ]);
        await waitForReplies(1);
        await send("two", "What is my name?");
        await waitForReplies(2);
        assert.ok(
          generated[1]?.messages.some(
            (message) => message.content === "My name is Ada",
          ),
        );
        await send("three", "fail");
        await waitForReplies(3);
        assert.match(replies[2]!.text, /trouble answering/);
        await send("four", "Still there?");
        await waitForReplies(4);
        assert.ok(
          !generated
            .at(-1)!
            .messages.some((message) => message.content === "fail"),
        );
        await send("five", "/reset");
        await waitForReplies(5);
        assert.equal(
          replies[4]!.text,
          "Started a fresh conversation. What would you like to talk about?",
        );
        assert.equal(traces.length, 1, "Reset must defer trace creation");
        await send("six", "New conversation");
        await waitForReplies(6);
        assert.equal(traces.length, 2);
        assert.notEqual(traces[0], traces[1]);
        assert.equal(generated.at(-1)!.trace, traces[1]);
        assert.equal(generated.at(-1)!.turn, 0);
        assert.deepEqual(
          generated.at(-1)!.messages.map((message) => message.role),
          ["system", "user"],
        );
        await send("one", "My name is Ada");
        await send("seven", "Final message");
        await waitForReplies(7);
        assert.deepEqual(
          replies.map((reply) => reply.messageId),
          ["one", "two", "three", "four", "five", "six", "seven"],
        );
        const originalRun = (
          await client.workflow.getHandle(workflowId).describe()
        ).runId;
        // Cross the 100-message rollover in one batch. Context and
        // duplicate suppression must survive the new workflow run.
        await Promise.all(
          Array.from({ length: 98 }, (_, index) =>
            send(`rollover-${index}`, `Message ${index}`),
          ),
        );
        await waitForReplies(8);
        // The reply activity can finish just before continue-as-new is recorded.
        const rolloverDeadline = Date.now() + 10_000;
        while (
          (await client.workflow.getHandle(workflowId).describe()).runId ===
            originalRun &&
          Date.now() < rolloverDeadline
        )
          await new Promise((resolve) => setTimeout(resolve, 25));
        const nextRun = (await client.workflow.getHandle(workflowId).describe())
          .runId;
        assert.notEqual(nextRun, originalRun);
        assert.equal(
          generated
            .at(-1)!
            .messages.filter((message) => message.role === "user").length,
          3,
        );
        await send("one", "My name is Ada");
        await send("after-rollover", "One more message");
        await waitForReplies(9);
        assert.equal(new Set(replies.map((reply) => reply.messageId)).size, 9);
        await send("search-budget", "search then time");
        await waitForReplies(10);
        assert.equal(generated.at(-3)!.webSearchBudget, 50);
        assert.equal(generated.at(-2)!.webSearchBudget, 38);
        assert.equal(generated.at(-1)!.webSearchBudget, 0);
        await send("fresh-search-budget", "New search allowance");
        await waitForReplies(11);
        assert.equal(generated.at(-1)!.webSearchBudget, 50);
        assert.equal(traces.length, 2, "Later turns must reuse the new trace");
        assert.deepEqual(
          generated.map(({ trace, turn, step }) => ({ trace, turn, step })),
          [
            ...[0, 1, 2, 3].map((turn) => ({ trace: traces[0], turn, step: 0 })),
            ...[0, 1, 2, 3].map((turn) => ({ trace: traces[1], turn, step: 0 })),
            ...[0, 1, 2].map((step) => ({ trace: traces[1], turn: 4, step })),
            { trace: traces[1], turn: 5, step: 0 },
          ],
        );
        assert.deepEqual(toolTraces, [traces[1], traces[1]]);
        await client.workflow
          .getHandle(workflowId)
          .terminate("Integration test complete");
      });
    } finally {
      await client.workflow
        .getHandle(workflowId)
        .terminate("Integration test cleanup")
        .catch(() => undefined);
      await connection.close();
      await native.close();
    }
  },
);

describe("rapid message batching", () => {
  let env: TestWorkflowEnvironment;
  let workflowBundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;

  before(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    workflowBundle = await bundleWorkflowCode({
      workflowsPath: require.resolve("../../workflows"),
    });
  });
  after(async () => env?.teardown());

  async function waitFor(predicate: () => boolean, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(predicate(), "Expected workflow progress before timeout");
  }

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  function message(id: string, text: string): LinqIncomingMessage {
    return {
      chatId: "chat-1",
      messageId: id,
      eventId: `event-${id}`,
      text,
      hasAttachments: false,
    };
  }

  function conversation(
    t: TestContext,
    hooks: {
      generate?: (input: GenerateInput) => Promise<void>;
      send?: (reply: LinqReply) => Promise<void>;
    } = {},
  ) {
    const taskQueue = `batch-test:${randomUUID()}`;
    const generated: GenerateInput[] = [];
    const generatedAt: number[] = [];
    const attempts: LinqReply[] = [];
    const replies: LinqReply[] = [];
    const traces: string[] = [];
    const chats = new Set<string>();
    const handle = (chatId = "chat-1") =>
      env.client.workflow.getHandle(`${taskQueue}:${chatId}`);
    t.after(async () => {
      for (const chat of chats)
        await handle(chat)
          .terminate("Test cleanup")
          .catch(() => undefined);
    });
    const worker = () =>
      Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowBundle,
        // Replay each task; avoid stale sticky queues when restarting a test worker.
        maxCachedWorkflows: 0,
        activities: {
          startTrace: async () => {
            const trace = `batch-test-trace-${traces.length}`;
            traces.push(trace);
            return trace;
          },
          generate: async (input: GenerateInput) => {
            generated.push(input);
            generatedAt.push(await env.currentTimeMs());
            await hooks.generate?.(input);
            return {
              message: { role: "assistant", content: "Test reply" },
              text: "Test reply",
              toolCalls: [],
            };
          },
          sendLinqReply: async (reply: LinqReply) => {
            attempts.push(reply);
            await hooks.send?.(reply);
            replies.push(reply);
          },
        },
      });
    // The built-in query waits for the worker to apply signals and timer events.
    const settled = (chatId = "chat-1") =>
      handle(chatId).query("__stack_trace");
    return {
      generated,
      generatedAt,
      attempts,
      replies,
      traces,
      worker,
      handle,
      settled,
      async run(fn: () => Promise<void>) {
        await (await worker()).runUntil(fn);
      },
      async send(input: LinqIncomingMessage, waitForWorker = true) {
        chats.add(input.chatId);
        await env.client.workflow.signalWithStart(LINQ_CONVERSATION, {
          workflowId: `${taskQueue}:${input.chatId}`,
          taskQueue,
          signal: LINQ_MESSAGE,
          signalArgs: [input],
        });
        if (waitForWorker) await settled(input.chatId);
      },
      async start(state: Parameters<typeof linqConversation>[0]) {
        chats.add("chat-1");
        await env.client.workflow.start(LINQ_CONVERSATION, {
          workflowId: `${taskQueue}:chat-1`,
          taskQueue,
          args: [state],
        });
        await settled();
      },
      async advance(ms: number) {
        await env.sleep(ms);
        for (const chat of chats) await settled(chat);
      },
      async waitForReplies(count: number) {
        await waitFor(() => replies.length >= count);
        assert.equal(replies.length, count);
      },
    };
  }

  test(
    "text, link and attachment messages extend the quiet period and form one ordered turn",
    { timeout: 60_000 },
    async (t) => {
      const c = conversation(t);
      await c.run(async () => {
        await c.send(message("text", "What do you think of this?"));
        await c.advance(1_000);
        await c.send(message("link", "https://example.com/article"));
        await c.advance(1_000);
        await c.send({ ...message("photo", ""), hasAttachments: true });
        await c.advance(1_500);
        assert.equal(c.generated.length, 0);
        await c.advance(600);
        await c.waitForReplies(1);
        const content =
          "What do you think of this?\n\nhttps://example.com/article\n\n\n" +
          "[An attachment was included but is not available to you.]";
        assert.equal(c.generated[0]!.messages.at(-1)!.content, content);
        assert.equal(c.replies[0]!.messageId, "text");

        await c.send(message("followup", "Why?"));
        await c.advance(2_100);
        await c.waitForReplies(2);
        assert.deepEqual(
          c.generated[1]!.messages.filter((item) => item.role === "user"),
          [
            { role: "user", content },
            { role: "user", content: "Why?" },
          ],
        );
        assert.equal(c.generated[1]!.turn, 1);
      });
    },
  );

  test(
    "isolated messages wait two seconds; neither duplicate key extends that wait",
    { timeout: 60_000 },
    async (t) => {
      const c = conversation(t);
      await c.run(async () => {
        const first = message("one", "Hello");
        await c.send(first);
        const startedAt = await env.currentTimeMs();
        await c.advance(1_500);
        assert.equal(c.generated.length, 0);
        await c.send({ ...first, eventId: "different-event" });
        await c.send({ ...first, messageId: "different-message" });
        await c.advance(600);
        await c.waitForReplies(1);
        assert.ok(
          c.generatedAt[0]! - startedAt < 2_500,
          "Duplicates must not postpone the original two-second deadline",
        );
        assert.equal(c.generated.length, 1);
        assert.equal(c.generated[0]!.messages.at(-1)!.content, "Hello");
        await c.send(first);
        await c.advance(2_100);
        assert.equal(c.replies.length, 1);
      });
    },
  );

  test(
    "a continuous burst starts its turn at the ten-second cap",
    { timeout: 60_000 },
    async (t) => {
      const c = conversation(t);
      await c.run(async () => {
        await c.send(message("burst-0", "Message 0"));
        const startedAt = await env.currentTimeMs();
        for (let index = 1; index <= 6; index++) {
          await c.advance(1_500);
          assert.equal(c.generated.length, 0);
          await c.send(message(`burst-${index}`, `Message ${index}`));
        }
        // Only 1.1 seconds of quiet, but 10.1 seconds since the first message.
        await c.advance(1_100);
        await c.waitForReplies(1);
        assert.ok(
          c.generatedAt[0]! - startedAt < 10_500,
          "The first turn must start at the cap, even without two seconds of quiet",
        );
        assert.equal(
          c.generated[0]!.messages.at(-1)!.content,
          Array.from({ length: 7 }, (_, index) => `Message ${index}`).join(
            "\n\n",
          ),
        );
        await c.send(message("next-burst", "Next batch"));
        await c.advance(2_100);
        await c.waitForReplies(2);
        assert.equal(c.generated[1]!.messages.at(-1)!.content, "Next batch");
      });
    },
  );

  test(
    "reset closes a pending batch immediately and receives its own acknowledgment",
    { timeout: 60_000 },
    async (t) => {
      const c = conversation(t);
      await c.run(async () => {
        await c.send(message("before", "Before reset"));
        await c.send(message("reset", "/RESET"));
        await c.waitForReplies(2);
        assert.equal(c.generated.length, 1);
        assert.deepEqual(
          c.replies.map((reply) => reply.messageId),
          ["before", "reset"],
        );
        assert.match(c.replies[1]!.text, /Started a fresh conversation/);
        assert.equal(c.traces.length, 1);
        await c.send(message("after", "After reset"));
        await c.advance(2_100);
        await c.waitForReplies(3);
        assert.deepEqual(
          c.generated[1]!.messages.map((item) => item.role),
          ["system", "user"],
        );
        assert.equal(c.traces.length, 2);
        assert.equal(c.generated[1]!.trace, c.traces[1]);
        assert.equal(c.generated[1]!.turn, 0);
      });
    },
  );

  test(
    "messages and reset arriving during generation stay queued in order",
    { timeout: 60_000 },
    async (t) => {
      const gate = deferred();
      t.after(gate.resolve);
      const c = conversation(t, {
        generate: async (input) => {
          if (input.messages.at(-1)!.content === "In progress")
            await gate.promise;
        },
      });
      try {
        await c.run(async () => {
          await c.send(message("active", "In progress"));
          await c.advance(2_100);
          await waitFor(() => c.generated.length === 1);
          await c.send(message("queued-text", "Queued text"));
          await c.send(message("queued-link", "https://example.com"));
          await c.send(message("reset", "/reset"));
          await c.send(message("after", "Fresh context"));
          assert.equal(c.replies.length, 0);
          gate.resolve();
          await c.waitForReplies(3);
          assert.equal(
            c.generated[1]!.messages.at(-1)!.content,
            "Queued text\n\nhttps://example.com",
          );
          await c.advance(2_100);
          await c.waitForReplies(4);
          assert.deepEqual(
            c.replies.map((reply) => reply.messageId),
            ["active", "queued-text", "reset", "after"],
          );
          assert.deepEqual(
            c.generated[2]!.messages.map((item) => item.role),
            ["system", "user"],
          );
          assert.equal(c.traces.length, 2);
          assert.deepEqual(
            c.generated.map(({ trace, turn }) => ({ trace, turn })),
            [
              { trace: c.traces[0], turn: 0 },
              { trace: c.traces[0], turn: 1 },
              { trace: c.traces[1], turn: 0 },
            ],
          );
        });
      } finally {
        gate.resolve();
      }
    },
  );

  test(
    "chats have independent queues and quiet periods",
    { timeout: 60_000 },
    async (t) => {
      const c = conversation(t);
      await c.run(async () => {
        await c.send(message("chat-one", "First chat"));
        await c.advance(1_000);
        await c.send({
          ...message("chat-two", "Second chat"),
          chatId: "chat-2",
        });
        await c.advance(1_100);
        await c.waitForReplies(1);
        assert.equal(c.replies[0]!.chatId, "chat-1");
        await c.advance(1_000);
        await c.waitForReplies(2);
        assert.equal(c.replies[1]!.chatId, "chat-2");
        for (const input of c.generated)
          assert.deepEqual(
            input.messages.map((item) => item.role),
            ["system", "user"],
          );
      });
    },
  );

  test(
    "worker restart retains the pending batch, elapsed timer and duplicate suppression",
    { timeout: 60_000 },
    async (t) => {
      const c = conversation(t);
      await c.run(async () => {
        await c.send(message("text", "Read this"));
        await c.advance(500);
        await c.send(message("link", "https://example.com"));
        assert.equal(c.generated.length, 0);
      });
      // Expire the existing timer with no worker polling this queue.
      await env.sleep(3_000);
      await c.send(
        { ...message("link", "https://example.com"), eventId: "redelivery" },
        false,
      );
      await c.run(async () => {
        await c.settled();
        // No new quiet period is needed after replaying the elapsed timer.
        await waitFor(() => c.replies.length === 1, 1_500);
        assert.equal(c.generated.length, 1);
        assert.equal(
          c.generated[0]!.messages.at(-1)!.content,
          "Read this\n\nhttps://example.com",
        );
        assert.equal(c.replies[0]!.messageId, "text");
      });
    },
  );

  test(
    "activity retries preserve the batch and reply idempotency key",
    { timeout: 60_000 },
    async (t) => {
      let generations = 0;
      let sends = 0;
      const c = conversation(t, {
        generate: async () => {
          if (++generations === 1) throw new Error("Temporary model failure");
        },
        send: async () => {
          if (++sends === 1) throw new Error("Temporary send failure");
        },
      });
      await c.run(async () => {
        await c.send(message("first", "Text"));
        await c.send(message("second", "https://example.com"));
        await c.advance(2_100);
        await waitFor(() => generations === 1);
        await c.send(message("later", "Later message"));
        await c.advance(2_100);
        await waitFor(() => sends === 1);
        await c.advance(2_100);
        await c.waitForReplies(2);
        assert.deepEqual(c.generated[0], c.generated[1]);
        assert.deepEqual(c.attempts[0], c.attempts[1]);
        assert.equal(c.attempts[0]!.messageId, "first");
        assert.equal(c.generated[2]!.messages.at(-1)!.content, "Later message");
      });
    },
  );

  test(
    "rollover counts messages and preserves pending messages, memory and all batch IDs",
    { timeout: 60_000 },
    async (t) => {
      const gate = deferred();
      t.after(gate.resolve);
      const pending = Array.from({ length: 100 }, (_, index) =>
        message(`bulk-${index}`, `Message ${index}`),
      );
      const c = conversation(t, {
        generate: async (input) => {
          if (input.turn === 20) await gate.promise;
        },
      });
      try {
        await c.run(async () => {
          await c.start({
            turns: Array.from({ length: 20 }, (_, index): Message[] => [
              { role: "user", content: `Old turn ${index}` },
              { role: "assistant", content: "Old reply" },
            ]),
            pending,
            seen: pending.flatMap((item) => [
              `event:${item.eventId}`,
              `message:${item.messageId}`,
            ]),
            turn: 20,
            trace: "existing-trace",
          });
          const originalRun = (await c.handle().describe()).runId;
          await c.advance(2_100);
          await waitFor(() => c.generated.length === 1);
          await c.send(message("queued", "Carry me into the next run"));
          const queuedAt = await env.currentTimeMs();
          await c.send(pending[99]!);
          await c.advance(1_500);
          gate.resolve();
          await c.waitForReplies(1);
          const deadline = Date.now() + 5_000;
          while (
            (await c.handle().describe()).runId === originalRun &&
            Date.now() < deadline
          )
            await new Promise((resolve) => setTimeout(resolve, 10));
          assert.notEqual((await c.handle().describe()).runId, originalRun);
          await c.advance(600);
          await c.waitForReplies(2);
          assert.ok(
            c.generatedAt[1]! - queuedAt < 2_500,
            "Rollover must preserve the pending message's quiet-period deadline",
          );
          assert.equal(
            c.generated[1]!.messages.at(-1)!.content,
            "Carry me into the next run",
          );
          assert.equal(
            c.generated[1]!.messages.filter((item) => item.role === "user")
              .length,
            21,
          );
          assert.equal(c.generated[1]!.trace, "existing-trace");
          assert.equal(c.generated[1]!.turn, 21);
          await c.send({ ...pending[0]!, eventId: "new-event" });
          await c.send({ ...pending[99]!, messageId: "new-message" });
          await c.send(message("after", "After rollover"));
          await c.advance(2_100);
          await c.waitForReplies(3);
          assert.deepEqual(
            c.replies.map((reply) => reply.messageId),
            ["bulk-0", "queued", "after"],
          );
        });
      } finally {
        gate.resolve();
      }
    },
  );

  test(
    "attachment-only batches and oversized input keep the existing fallback replies",
    { timeout: 60_000 },
    async (t) => {
      const c = conversation(t);
      await c.run(async () => {
        await c.send({ ...message("photo-1", ""), hasAttachments: true });
        await c.send({ ...message("photo-2", ""), hasAttachments: true });
        await c.advance(2_100);
        await c.waitForReplies(1);
        assert.match(c.replies[0]!.text, /Please describe/);
        await c.send(message("long", "x".repeat(16_001)));
        await c.advance(2_100);
        await c.waitForReplies(2);
        assert.match(c.replies[1]!.text, /Please send a shorter version/);
        await c.send(message("part-one", "x".repeat(8_000)));
        await c.send(message("part-two", "x".repeat(8_000)));
        await c.advance(2_100);
        await c.waitForReplies(3);
        assert.match(c.replies[2]!.text, /Please send a shorter version/);
        assert.equal(c.generated.length, 0);
        await c.send(message("valid", "x".repeat(16_000)));
        await c.advance(2_100);
        await c.waitForReplies(4);
        assert.equal(c.generated.length, 1);
        assert.deepEqual(
          c.generated[0]!.messages.map((item) => item.role),
          ["system", "user"],
        );
      });
    },
  );
});
