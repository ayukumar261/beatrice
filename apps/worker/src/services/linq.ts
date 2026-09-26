import Linq from "@linqapp/sdk";
import { ApplicationFailure } from "@temporalio/common";

export interface LinqReply {
  chatId: string;
  messageId: string;
  text: string;
}

export function createLinqActivities(
  apiKey = process.env.LINQ_API_KEY,
  client?: Linq,
) {
  if (!apiKey) {
    throw new Error(
      "LINQ_API_KEY is not set — add it to the .env file at the repo root.",
    );
  }
  const linq = client ?? new Linq({ apiKey, timeout: 15_000, maxRetries: 0 });
  return {
    async sendLinqReply(input: LinqReply): Promise<void> {
      try {
        await linq.chats.messages.send(input.chatId, {
          message: {
            parts: [{ type: "text", value: input.text }],
            idempotency_key: `beatrice:${input.messageId}`,
          },
        });
      } catch (error) {
        if (error instanceof Linq.APIError) {
          const status = error.status;
          throw ApplicationFailure.create({
            message: `Linq send failed (HTTP ${status ?? "unknown"})`,
            type: "LinqSendError",
            nonRetryable:
              typeof status === "number" &&
              status >= 400 &&
              status < 500 &&
              ![408, 409, 429].includes(status),
          });
        }
        throw error;
      }
    },
  };
}
