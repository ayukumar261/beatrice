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
  /** Present only for image attachments; older workflow signals omit it. */
  images?: LinqImage[];
  hasUnsupportedAttachments?: boolean;
}

export interface LinqImage {
  id: string;
  url: string;
  mimeType: string;
}

export const IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];
export const MAX_IMAGES_PER_TURN = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Images stay as private object references in Temporal and Braintrust. */
export type UserContentPart =
  { type: "text"; text: string } | { type: "stored_image"; key: string };

/** Minimal chat message shapes; the activity resolves images to OpenAI wire format. */
export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string | UserContentPart[] }
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
