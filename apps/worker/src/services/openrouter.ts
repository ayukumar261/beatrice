import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { currentSpan, traced } from "braintrust";
import OpenAI from "openai";

import type { Message, ToolCall } from "@repo/types";
import { toolDefinitions } from "../tools";
import { flushLogs } from "./braintrust";

const REQUEST_TIMEOUT_MS = 100_000;

export interface CompletionInput {
  model: string;
  messages: Message[];
  tools: string[];
}

export interface GenerateInput extends CompletionInput {
  step: number;
  trace: string;
}

export interface GenerateOutput {
  message: Message;
  text: string;
  toolCalls: ToolCall[];
}

interface Completion extends GenerateOutput {
  usage?: OpenAI.CompletionUsage;
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
            step: input.step,
            attempt,
          },
        });

        // Keep the activity alive while waiting on the model. An independent
        // deadline and Temporal cancellation bound the HTTP request.
        ctx.heartbeat();
        const heartbeat = setInterval(() => ctx.heartbeat(), 5_000);
        heartbeat.unref();
        try {
          const { usage, ...output } = await complete(
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
            ...(usage && {
              metrics: {
                prompt_tokens: usage.prompt_tokens,
                completion_tokens: usage.completion_tokens,
                tokens: usage.total_tokens,
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
  const stream = await client.chat.completions.create(
    {
      model: input.model,
      messages: input.messages,
      tools: input.tools.length > 0 ? toolDefinitions(input.tools) : undefined,
      stream: true,
      stream_options: { include_usage: true },
    },
    { signal, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 },
  );

  let text = "";
  let usage: OpenAI.CompletionUsage | undefined;
  const partials = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage;
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
  }

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
  return { message, text, toolCalls, usage };
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
