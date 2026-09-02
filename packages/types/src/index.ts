/** Task queue shared by the worker and anything that starts workflows on it. */
export const TASK_QUEUE = "agents";

/** Minimal OpenAI-wire chat message shapes. */
export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

/** Minimal OpenAI-wire tool call shape (no dependency on the `openai` package). */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** JSON-schema function tool definition, as sent to the model. */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Workflow signature for the `corbyn` agent. */
export interface CorbynInput {
  task: string;
}

export interface CorbynOutput {
  text: string;
  steps: number;
}
