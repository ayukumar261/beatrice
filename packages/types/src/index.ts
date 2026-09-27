/** Task queue shared by the worker and anything that starts workflows on it. */
export const TASK_QUEUE = "agents";

/**
 * The SMS conversation workflow and the signal it registers. The gateway
 * addresses them by these names and never imports workflow code.
 */
export const LINQ_CONVERSATION = "linqConversation";
export const LINQ_MESSAGE = "linqMessage";

/** `linqMessage` signal payload: one inbound text, already validated. */
export interface LinqIncomingMessage {
  eventId: string;
  messageId: string;
  chatId: string;
  text: string;
  hasAttachments: boolean;
}

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
