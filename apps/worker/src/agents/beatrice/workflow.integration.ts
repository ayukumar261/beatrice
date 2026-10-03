import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Client, Connection } from "@temporalio/client";
import { ApplicationFailure } from "@temporalio/common";
import { NativeConnection, Worker } from "@temporalio/worker";
import { LINQ_CONVERSATION, LINQ_MESSAGE } from "@repo/types";
import type { LinqIncomingMessage } from "@repo/types";
import type { LinqReply } from "../../services/linq";
import type { GenerateInput } from "../../services/openrouter";

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
    const worker = await Worker.create({
      connection: native,
      taskQueue,
      workflowsPath: require.resolve("../../workflows"),
      activities: {
        startTrace: async () => "test-trace",
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
        executeTool: async () => "Test time",
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
        await send("six", "New conversation");
        await waitForReplies(6);
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
        // Cross the 100-turn rollover with messages still queued. Context and
        // duplicate suppression must survive the new workflow run.
        await Promise.all(
          Array.from({ length: 98 }, (_, index) =>
            send(`rollover-${index}`, `Message ${index}`),
          ),
        );
        await waitForReplies(105, 40_000);
        const nextRun = (await client.workflow.getHandle(workflowId).describe())
          .runId;
        assert.notEqual(nextRun, originalRun);
        assert.equal(
          generated
            .at(-1)!
            .messages.filter((message) => message.role === "user").length,
          21,
        );
        await send("one", "My name is Ada");
        await send("after-rollover", "One more message");
        await waitForReplies(106);
        assert.equal(
          new Set(replies.map((reply) => reply.messageId)).size,
          106,
        );
        await send("search-budget", "search then time");
        await waitForReplies(107);
        assert.equal(generated.at(-3)!.webSearchBudget, 50);
        assert.equal(generated.at(-2)!.webSearchBudget, 38);
        assert.equal(generated.at(-1)!.webSearchBudget, 0);
        await send("fresh-search-budget", "New search allowance");
        await waitForReplies(108);
        assert.equal(generated.at(-1)!.webSearchBudget, 50);
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
