import {
  ApplicationFailure,
  proxyActivities,
  workflowInfo,
} from "@temporalio/workflow";

import type { Message, CorbynInput, CorbynOutput } from "@repo/types";
import type * as braintrust from "../../services/braintrust";
import type { createOpenRouterActivities } from "../../services/openrouter";
import type * as tools from "../../tools";

const MODEL = "anthropic/claude-sonnet-4.5";
const SYSTEM = "You are Corbyn. Use the available tools when they help you answer accurately.";
const MAX_STEPS = 8;
const TOOLS = ["get_time"];

const { generate } = proxyActivities<
  ReturnType<typeof createOpenRouterActivities>
>({
  startToCloseTimeout: "2 minutes",
  heartbeatTimeout: "15 seconds",
  retry: {
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumAttempts: 5,
  },
});

const { executeTool } = proxyActivities<Pick<typeof tools, "executeTool">>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 3 },
});

const { record, startTrace } = proxyActivities<
  Pick<typeof braintrust, "record" | "startTrace">
>({
  startToCloseTimeout: "10 seconds",
  retry: { initialInterval: "1 second", maximumAttempts: 10 },
});

export async function corbyn(input: CorbynInput): Promise<CorbynOutput> {
  const { workflowId } = workflowInfo();
  const messages: Message[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: input.task },
  ];
  let trace: string | undefined;

  try {
    trace = await startTrace({ agent: "corbyn", task: input.task });

    for (let step = 0; step < MAX_STEPS; step++) {
      const { message, text, toolCalls } = await generate({
        model: MODEL,
        messages,
        tools: TOOLS,
        step,
        trace,
      });
      messages.push(message);

      if (toolCalls.length === 0) {
        const output: CorbynOutput = { text, steps: step + 1 };
        await record({
          workflowId,
          agent: "corbyn",
          status: "completed",
          steps: output.steps,
          trace,
          output: text,
        });
        return output;
      }

      for (const call of toolCalls) {
        const content = await executeTool(call, trace);
        messages.push({ role: "tool", tool_call_id: call.id, content });
      }
    }

    throw ApplicationFailure.create({
      message: `corbyn exceeded ${MAX_STEPS} steps`,
      nonRetryable: true,
    });
  } catch (err) {
    await record({ workflowId, agent: "corbyn", status: "failed", trace });
    throw err;
  }
}
