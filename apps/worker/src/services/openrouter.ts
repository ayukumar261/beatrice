import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { currentSpan, traced } from "braintrust";
import OpenAI from "openai";

import type { Message, ToolCall } from "@repo/types";
import { toolDefinitions } from "../tools";
import { flushLogs } from "./braintrust";

const REQUEST_TIMEOUT_MS = 100_000;

/** Parallel "fast" search through OpenRouter: three short results per search. */
const WEB_SEARCH_TOOL = {
  type: "openrouter:web_search",
  parameters: {
    engine: "parallel",
    mode: "fast",
    max_results: 3,
    max_characters: 1500,
  },
};

export interface CompletionInput {
  model: string;
  messages: Message[];
  tools: string[];
  webSearchBudget: number;
}

export interface GenerateInput extends CompletionInput {
  turn: number;
  step: number;
  trace: string;
}

export interface GenerateOutput {
  message: Message;
  text: string;
  toolCalls: ToolCall[];
  webSearchBudgetConsumed?: number;
}

type Usage = OpenAI.CompletionUsage & {
  cost?: number;
  server_tool_use?: { web_search_requests?: number };
  server_tool_use_details?: { web_search_requests?: number };
};

interface Completion extends GenerateOutput {
  usage?: Usage;
  sources: string[];
  webSearches?: number;
}

interface Annotation {
  type?: string;
  url_citation?: { url?: string };
}

export function createOpenRouterActivities(
  apiKey = process.env.OPENROUTER_API_KEY,
) {
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not set — add it to the .env file at the repo root.",
    );
  }
  const client = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
  });

  async function generate(input: GenerateInput): Promise<GenerateOutput> {
    return traced(
      async () => {
        const ctx = Context.current();
        const { attempt, workflowExecution } = ctx.info;
        currentSpan().log({
          metadata: {
            workflowId: workflowExecution?.workflowId ?? "unknown",
            turn: input.turn,
            step: input.step,
            attempt,
          },
        });

        // Searches can delay the first token. Keep the activity alive while an
        // independent deadline and Temporal cancellation bound the HTTP request.
        ctx.heartbeat();
        const heartbeat = setInterval(() => ctx.heartbeat(), 5_000);
        heartbeat.unref();
        try {
          const { usage, sources, webSearches, ...output } = await complete(
            client,
            input,
            AbortSignal.any([
              ctx.cancellationSignal,
              AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            ]),
          );
          currentSpan().log({
            input: input.messages,
            output: output.message,
            metadata: {
              sources,
              webSearchBudgetConsumed: output.webSearchBudgetConsumed,
            },
            ...(usage && {
              metrics: {
                prompt_tokens: usage.prompt_tokens,
                completion_tokens: usage.completion_tokens,
                tokens: usage.total_tokens,
                ...(usage.cost !== undefined && { cost: usage.cost }),
                web_search_requests: webSearches ?? 0,
              },
            }),
          });
          return output;
        } catch (err) {
          // Error spans are the ones a crashed retry can lose — make them durable now.
          await flushLogs();
          throw ctx.cancellationSignal.aborted
            ? ctx.cancellationSignal.reason
            : toFailure(err);
        } finally {
          clearInterval(heartbeat);
        }
      },
      { name: "generate", type: "llm", parent: input.trace },
    );
  }

  return { generate };
}

/** One streamed chat completion, accumulated into a message. */
export async function complete(
  client: OpenAI,
  input: CompletionInput,
  signal?: AbortSignal,
): Promise<Completion> {
  const { webSearchBudget } = input;
  const search = webSearchBudget > 0;
  const request = {
    model: input.model,
    messages: input.messages,
    tools: [
      ...toolDefinitions(input.tools),
      ...(search
        ? [
            {
              ...WEB_SEARCH_TOOL,
              parameters: {
                ...WEB_SEARCH_TOOL.parameters,
                max_uses: webSearchBudget,
                max_total_results:
                  WEB_SEARCH_TOOL.parameters.max_results * webSearchBudget,
              },
            },
          ]
        : []),
    ],
    // max_tool_calls is capped at 30; stop conditions support our full budget.
    // https://openrouter.ai/docs/guides/features/server-tools#tool-call-limits
    ...(search && {
      stop_server_tools_when: [
        { type: "step_count_is", step_count: webSearchBudget },
      ],
    }),
    stream: true as const,
    stream_options: { include_usage: true },
  };
  // OpenRouter accepts server tools in addition to the OpenAI SDK's tool types.
  const stream = await client.chat.completions.create(
    request as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
    { signal, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 },
  );

  let text = "";
  let usage: Usage | undefined;
  const sourceUrls = new Set<string>();
  const partials = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage as Usage;
    const delta = chunk.choices[0]?.delta;
    if (delta?.content) text += delta.content;
    for (const tc of delta?.tool_calls ?? []) {
      const partial = partials.get(tc.index) ?? {
        id: "",
        name: "",
        arguments: "",
      };
      if (tc.id) partial.id = tc.id;
      if (tc.function?.name) partial.name += tc.function.name;
      if (tc.function?.arguments) partial.arguments += tc.function.arguments;
      partials.set(tc.index, partial);
    }
    for (const value of [chunk, delta]) {
      const annotations = (value as { annotations?: Annotation[] } | undefined)
        ?.annotations;
      for (const annotation of annotations ?? []) {
        if (annotation.type !== "url_citation") continue;
        try {
          const url = new URL(annotation.url_citation?.url ?? "");
          if (["https:", "http:"].includes(url.protocol))
            sourceUrls.add(url.href);
        } catch {
          // Ignore malformed citations without discarding the model's answer.
        }
      }
    }
  }

  const sources = [...sourceUrls];
  if (sources.length && !sources.some((url) => text.includes(url)))
    text =
      `${text.trimEnd()}\n\nSources:\n${sources.slice(0, 2).join("\n")}`.trim();
  const toolCalls: ToolCall[] = [...partials.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, partial]) => ({
      id: partial.id,
      type: "function",
      function: { name: partial.name, arguments: partial.arguments },
    }));
  const message: Message = toolCalls.length
    ? { role: "assistant", content: text || null, tool_calls: toolCalls }
    : { role: "assistant", content: text };
  const webSearches =
    usage?.server_tool_use_details?.web_search_requests ??
    usage?.server_tool_use?.web_search_requests;
  // Missing or inconsistent accounting consumes the remaining allowance, so
  // subsequent model calls cannot accidentally exceed the turn's search budget.
  const reliableSearchUsage =
    typeof webSearches === "number" &&
    Number.isInteger(webSearches) &&
    webSearches >= 0 &&
    (webSearches > 0 || sources.length === 0);
  const webSearchBudgetConsumed = search
    ? reliableSearchUsage
      ? Math.min(webSearchBudget, webSearches)
      : webSearchBudget
    : 0;
  return {
    message,
    text,
    toolCalls,
    usage,
    sources,
    webSearches,
    webSearchBudgetConsumed,
  };
}

function toFailure(err: unknown): unknown {
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    if (
      typeof status === "number" &&
      status >= 400 &&
      status < 500 &&
      status !== 408 &&
      status !== 429
    ) {
      return ApplicationFailure.create({
        type: "OpenRouterClientError",
        message: `OpenRouter ${status}: ${err.message}`,
        nonRetryable: true,
      });
    }
  }
  return err;
}
