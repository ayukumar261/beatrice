import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { currentSpan, traced } from "braintrust";
import OpenAI from "openai";

import type { Message, ToolCall } from "@repo/types";
import { toolDefinitions } from "../tools";
import { flushLogs } from "./braintrust";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  throw new Error(
    "OPENROUTER_API_KEY is not set — add it to the .env file at the repo root.",
  );
}

const openrouter = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey,
});

export interface GenerateInput {
  model: string;
  messages: Message[];
  tools: string[];
  step: number;
  trace: string;
}

export interface GenerateOutput {
  message: Message;
  text: string;
  toolCalls: ToolCall[];
}

export async function generate(input: GenerateInput): Promise<GenerateOutput> {
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

      try {
        const stream = await openrouter.chat.completions.create({
          model: input.model,
          messages: input.messages,
          tools:
            input.tools.length > 0 ? toolDefinitions(input.tools) : undefined,
          stream: true,
          stream_options: { include_usage: true },
        });

        let text = "";
        let chunks = 0;
        let usage: OpenAI.CompletionUsage | undefined;
        const partials = new Map<
          number,
          { id: string; name: string; arguments: string }
        >();

        for await (const chunk of stream) {
          if (chunk.usage) usage = chunk.usage;
          const delta = chunk.choices[0]?.delta;
          if (delta?.content) {
            text += delta.content;
          }
          for (const tc of delta?.tool_calls ?? []) {
            const partial = partials.get(tc.index) ?? {
              id: "",
              name: "",
              arguments: "",
            };
            if (tc.id) partial.id = tc.id;
            if (tc.function?.name) partial.name += tc.function.name;
            if (tc.function?.arguments)
              partial.arguments += tc.function.arguments;
            partials.set(tc.index, partial);
          }
          // A stalled stream trips heartbeatTimeout long before startToCloseTimeout.
          if (++chunks % 25 === 0) {
            ctx.heartbeat(chunks);
          }
        }

        const toolCalls: ToolCall[] = [...partials.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, partial]) => ({
            id: partial.id,
            type: "function",
            function: { name: partial.name, arguments: partial.arguments },
          }));

        const message: Message =
          toolCalls.length > 0
            ? {
                role: "assistant",
                content: text.length > 0 ? text : null,
                tool_calls: toolCalls,
              }
            : { role: "assistant", content: text };

        currentSpan().log({
          input: input.messages,
          output: message,
          ...(usage && {
            metrics: {
              prompt_tokens: usage.prompt_tokens,
              completion_tokens: usage.completion_tokens,
              tokens: usage.total_tokens,
            },
          }),
        });

        return { message, text, toolCalls };
      } catch (err) {
        // Error spans are the ones a crashed retry can lose — make them durable now.
        await flushLogs();
        throw toFailure(err);
      }
    },
    { name: "generate", type: "llm", parent: input.trace },
  );
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
