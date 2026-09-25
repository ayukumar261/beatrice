import assert from "node:assert/strict";
import { test } from "node:test";
import OpenAI from "openai";
import { complete } from "./openrouter";

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
