import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { MockActivityEnvironment } from "@temporalio/testing";
import { _exportsForTestingOnly, setFetch } from "braintrust";
import OpenAI from "openai";
import { startTrace } from "./braintrust";
import { complete, createOpenRouterActivities } from "./openrouter";

function fakeClient(chunks: unknown[]) {
  const requests: Record<string, unknown>[] = [];
  const client = new OpenAI({
    apiKey: "test-key",
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
          "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  return { client, requests };
}

const input = {
  model: "test-model",
  messages: [{ role: "user" as const, content: "Look this up" }],
  tools: ["get_time"],
  webSearchBudget: 50,
};
const citation = (url: string) => ({
  type: "url_citation",
  url_citation: { url },
});

/** Advance a virtual monotonic clock as the SDK reads each SSE event. */
function timedClient(
  t: TestContext,
  events: { at: number; chunk: unknown; onRead?: () => void }[],
  endedAt = 8_000,
) {
  let now = 1_000;
  t.mock.method(performance, "now", () => now);
  return new OpenAI({
    apiKey: "test-key",
    fetch: async () => {
      now = 2_000; // HTTP setup is part of TTFT.
      let index = 0;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              const event = events[index++];
              now = event?.at ?? endedAt;
              event?.onRead?.();
              if (event?.chunk instanceof Error) {
                controller.error(event.chunk);
                return;
              }
              const data = event ? JSON.stringify(event.chunk) : "[DONE]";
              controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
              if (!event) controller.close();
            },
          },
          // Do not advance the clock for prefetched events.
          { highWaterMark: 0 },
        ),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
}

test("timing includes HTTP and search waits, ignores metadata, and ends after usage", async (t) => {
  const client = timedClient(t, [
    { at: 2_100, chunk: { choices: [{ delta: { role: "assistant" } }] } },
    { at: 2_200, chunk: { choices: [{ delta: { content: "" } }] } },
    {
      at: 2_300,
      chunk: { choices: [], annotations: [citation("https://example.com/")] },
    },
    { at: 2_400, chunk: { choices: [], usage: { completion_tokens: 0 } } },
    { at: 4_000, chunk: { choices: [{ delta: { content: "Hello" } }] } },
    { at: 5_000, chunk: { choices: [{ delta: { content: " world" } }] } },
    { at: 6_000, chunk: { choices: [{ delta: {}, finish_reason: "stop" }] } },
    { at: 7_000, chunk: { choices: [], usage: { completion_tokens: 12 } } },
  ]);
  const result = await complete(client, input);
  assert.deepEqual(result.metrics, {
    time_to_first_token: 3,
    tokens_per_second: 3,
  });
});

test("tool-call names and arguments each qualify as first output", async (t) => {
  for (const first of [{ name: "get_time" }, { arguments: "{}" }]) {
    await t.test(JSON.stringify(first), async (t) => {
      const client = timedClient(t, [
        {
          at: 2_500,
          chunk: {
            choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1" }] } }],
          },
        },
        {
          at: 3_000,
          chunk: {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, function: { name: "", arguments: "" } },
                  ],
                },
              },
            ],
          },
        },
        {
          at: 4_000,
          chunk: {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: first }] } },
            ],
          },
        },
        { at: 7_000, chunk: { choices: [], usage: { completion_tokens: 8 } } },
      ]);
      const result = await complete(client, input);
      assert.equal(result.text, "");
      assert.deepEqual(result.metrics, {
        time_to_first_token: 3,
        tokens_per_second: 2,
      });
    });
  }
});

test("streams without generated output omit timing even if citations produce reply text", async (t) => {
  const client = timedClient(t, [
    {
      at: 3_000,
      chunk: {
        choices: [
          {
            delta: {
              content: "",
              annotations: [citation("https://example.com/")],
            },
          },
        ],
      },
    },
    { at: 7_000, chunk: { choices: [], usage: { completion_tokens: 12 } } },
  ]);
  const result = await complete(client, input);
  assert.match(result.text, /Sources:/);
  assert.deepEqual(result.metrics, {});
});

test("missing or invalid usage and overflowing rates omit TPS but retain timing", async (t) => {
  for (const completionTokens of [undefined, null, -1, 1.5, "12", 1e308]) {
    await t.test(String(completionTokens), async (t) => {
      const client = timedClient(
        t,
        [
          { at: 4_000, chunk: { choices: [{ delta: { content: "Hello" } }] } },
          {
            at: 4_001,
            chunk: {
              choices: [],
              ...(completionTokens !== undefined && {
                usage: { completion_tokens: completionTokens },
              }),
            },
          },
        ],
        4_001,
      );
      assert.deepEqual((await complete(client, input)).metrics, {
        time_to_first_token: 3,
      });
    });
  }
});

test("zero-duration streams omit TPS; zero completion tokens yield zero TPS", async (t) => {
  for (const duration of [0, 4_000]) {
    await t.test(`duration ${duration}`, async (t) => {
      const client = timedClient(
        t,
        [
          { at: 4_000, chunk: { choices: [{ delta: { content: "Hello" } }] } },
          {
            at: 4_000,
            chunk: { choices: [], usage: { completion_tokens: 0 } },
          },
        ],
        4_000 + duration,
      );
      assert.deepEqual((await complete(client, input)).metrics, {
        time_to_first_token: 3,
        ...(duration > 0 && { tokens_per_second: 0 }),
      });
    });
  }
});

test("generate logs timing and model metadata on Braintrust spans without changing activity output", async (t) => {
  setFetch((async (url: string) => {
    if (String(url).endsWith("/api/project/register"))
      return Response.json({ project: { id: "project-1", name: "test" } });
    throw new Error(`unexpected network call: ${url}`);
  }) as typeof fetch);
  await _exportsForTestingOnly.simulateLoginForTests();
  const logs = _exportsForTestingOnly.useTestBackgroundLogger();
  t.after(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
    _exportsForTestingOnly.simulateLogoutForTests();
  });
  const env = new MockActivityEnvironment({
    workflowExecution: { workflowId: "linq:metrics", runId: "run-1" },
  });
  const trace = await env.run(startTrace, { agent: "beatrice-sms" });
  assert.ok(typeof trace === "string");
  await logs.drain();

  for (const withUsage of [true, false]) {
    await t.test(`usage ${withUsage}`, async (t) => {
      const client = timedClient(t, [
        { at: 4_000, chunk: { choices: [{ delta: { content: "Hello" } }] } },
        {
          at: 7_000,
          chunk: {
            choices: [],
            ...(withUsage && {
              usage: {
                prompt_tokens: 10,
                completion_tokens: 12,
                total_tokens: 22,
                cost: 0.001,
                server_tool_use: { web_search_requests: 2 },
              },
            }),
          },
        },
      ]);
      const { generate } = createOpenRouterActivities("test-key", client);
      const result = await env.run(generate, {
        ...input,
        trace,
        turn: 2,
        step: 1,
      });
      assert.deepEqual(result, {
        message: { role: "assistant", content: "Hello" },
        text: "Hello",
        toolCalls: [],
        webSearchBudgetConsumed: withUsage ? 2 : 50,
      });
      const [span] = (await logs.drain()) as Record<string, unknown>[];
      assert.deepEqual(span?.metadata, {
        workflowId: "linq:metrics",
        turn: 2,
        step: 1,
        attempt: 1,
        model: "test-model",
        sources: [],
        webSearchBudgetConsumed: withUsage ? 2 : 50,
      });
      const attributes = span?.span_attributes as Record<string, unknown>;
      assert.equal(attributes.name, "generate");
      assert.equal(attributes.type, "llm");
      const { start, end, ...metrics } = span?.metrics as Record<
        string,
        number
      >;
      assert.equal(typeof start, "number");
      assert.equal(typeof end, "number");
      assert.deepEqual(metrics, {
        time_to_first_token: 3,
        ...(withUsage && {
          tokens_per_second: 3,
          prompt_tokens: 10,
          completion_tokens: 12,
          tokens: 22,
          cost: 0.001,
          web_search_requests: 2,
        }),
      });
    });
  }

  for (const cancelled of [false, true]) {
    await t.test(`failed stream, cancelled ${cancelled}`, async (t) => {
      const client = timedClient(t, [
        { at: 4_000, chunk: { choices: [{ delta: { content: "Partial" } }] } },
        {
          at: 5_000,
          chunk: cancelled
            ? new DOMException("stream aborted", "AbortError")
            : new Error("stream interrupted"),
          onRead: cancelled ? () => env.cancel() : undefined,
        },
      ]);
      const { generate } = createOpenRouterActivities("test-key", client);
      await assert.rejects(
        env.run(generate, { ...input, trace, turn: 3, step: 0 }),
        cancelled
          ? (error: unknown) => error === env.context.cancellationSignal.reason
          : /stream interrupted/,
      );
      const [span] = (await logs.drain()) as Record<string, unknown>[];
      assert.ok(span?.error);
      const metrics = span?.metrics as Record<string, number>;
      for (const name of ["time_to_first_token", "tokens_per_second"])
        assert.equal(metrics[name], undefined);
    });
  }
});

test("streamed search sources and local tool calls survive the OpenAI SDK", async () => {
  const { client, requests } = fakeClient([
    {
      choices: [
        {
          delta: {
            content: "Found it.",
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                function: { name: "get_", arguments: '{"time' },
              },
            ],
          },
        },
      ],
      annotations: [
        citation("javascript:alert(1)"),
        citation("not-a-url"),
        citation("https://example.com/source"),
      ],
    },
    {
      choices: [
        {
          delta: {
            annotations: [
              citation("https://example.com/source"),
              citation("https://example.com/second"),
              citation("https://example.com/third"),
            ],
            tool_calls: [
              {
                index: 0,
                function: { name: "time", arguments: 'zone":"UTC"}' },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        cost: 0.0011,
        server_tool_use_details: { web_search_requests: 7 },
      },
    },
  ]);
  const result = await complete(client, input);
  assert.equal(
    result.text,
    "Found it.\n\nSources:\nhttps://example.com/source\nhttps://example.com/second",
  );
  assert.deepEqual(result.toolCalls, [
    {
      id: "call-1",
      type: "function",
      function: { name: "get_time", arguments: '{"timezone":"UTC"}' },
    },
  ]);
  assert.equal(result.message.content, result.text);
  assert.equal(result.webSearchBudgetConsumed, 7);
  const tools = requests[0]!.tools as {
    type: string;
    parameters?: Record<string, unknown>;
  }[];
  assert.equal(tools[0]?.type, "function");
  assert.equal(tools[1]?.type, "openrouter:web_search");
  assert.deepEqual(tools[1]?.parameters, {
    engine: "parallel",
    mode: "fast",
    max_uses: 50,
    max_results: 3,
    max_total_results: 150,
    max_characters: 1500,
  });
  assert.deepEqual(requests[0]!.stop_server_tools_when, [
    { type: "step_count_is", step_count: 50 },
  ]);
  assert.equal(requests[0]!.max_tool_calls, undefined);
});

test("an exhausted search budget preserves ordinary local tools", async () => {
  const { client, requests } = fakeClient([
    { choices: [{ delta: { content: "Hello" } }] },
  ]);
  const result = await complete(client, { ...input, webSearchBudget: 0 });
  assert.equal(result.text, "Hello");
  assert.equal(result.webSearchBudgetConsumed, 0);
  assert.deepEqual(
    (requests[0]!.tools as { type: string }[]).map((t) => t.type),
    ["function"],
  );
  assert.deepEqual(requests[0]!.messages, input.messages);
  assert.equal(requests[0]!.stop_server_tools_when, undefined);
  assert.equal(requests[0]!.max_tool_calls, undefined);
});

test("reported search usage is deducted and unused allowance remains available", async () => {
  for (const details of ["server_tool_use", "server_tool_use_details"]) {
    for (const count of [0, 1, 12, 50]) {
      const { client } = fakeClient([
        { choices: [], usage: { [details]: { web_search_requests: count } } },
      ]);
      assert.equal(
        (await complete(client, input)).webSearchBudgetConsumed,
        count,
      );
    }
  }
});

test("subsequent requests are limited to the remaining search allowance", async () => {
  const { client, requests } = fakeClient([
    { choices: [], usage: { server_tool_use: { web_search_requests: 38 } } },
  ]);
  const result = await complete(client, { ...input, webSearchBudget: 38 });
  const tools = requests[0]!.tools as {
    parameters?: Record<string, unknown>;
  }[];
  assert.equal(tools[1]?.parameters?.max_uses, 38);
  assert.equal(tools[1]?.parameters?.max_total_results, 114);
  assert.deepEqual(requests[0]!.stop_server_tools_when, [
    { type: "step_count_is", step_count: 38 },
  ]);
  assert.equal(result.webSearchBudgetConsumed, 38);
});

test("missing or inconsistent usage consumes the remaining allowance conservatively", async () => {
  for (const count of [undefined, -1, 1.5]) {
    const { client } = fakeClient([
      {
        choices: [],
        usage: { server_tool_use: { web_search_requests: count } },
      },
    ]);
    assert.equal((await complete(client, input)).webSearchBudgetConsumed, 50);
  }
  for (const count of [undefined, 0]) {
    const { client } = fakeClient([
      {
        choices: [{ delta: { content: "Answer: https://example.com/" } }],
        annotations: [citation("https://example.com/")],
        ...(count !== undefined && {
          usage: { server_tool_use: { web_search_requests: count } },
        }),
      },
    ]);
    const result = await complete(client, input);
    assert.equal(result.webSearchBudgetConsumed, 50);
    assert.equal(result.text, "Answer: https://example.com/");
  }
});
