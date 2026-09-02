import { ApplicationFailure } from "@temporalio/common";
import { currentSpan, traced } from "braintrust";

import type { ToolCall, ToolDefinition } from "@repo/types";
import { getTime } from "./get-time";

export interface Tool {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

const registry: Tool[] = [getTime];

const byName = new Map(
  registry.map((tool) => [tool.definition.function.name, tool]),
);

export function toolDefinitions(names: string[]): ToolDefinition[] {
  return names.map((name) => {
    const tool = byName.get(name);
    if (!tool) {
      throw new Error(`unknown tool in agent config: ${name}`);
    }
    return tool.definition;
  });
}

export async function executeTool(
  call: ToolCall,
  trace?: string,
): Promise<string> {
  const tool = byName.get(call.function.name);
  if (!tool) {
    throw ApplicationFailure.create({
      message: `unknown tool: ${call.function.name}`,
      nonRetryable: true,
    });
  }

  return traced(
    async () => {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<
          string,
          unknown
        >;
      } catch {
        // Returned to the model as the tool result so it can correct itself.
        return `Error: arguments for ${call.function.name} were not valid JSON.`;
      }
      const result = await tool.execute(args);
      currentSpan().log({ input: args, output: result });
      return result;
    },
    { name: call.function.name, type: "tool", parent: trace },
  );
}
