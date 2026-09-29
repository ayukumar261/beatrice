import type { LinqIncomingMessage } from "@repo/types";

import type { Config } from "../config";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid webhook object");
  return value as Record<string, unknown>;
}

function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw new Error("Invalid webhook identifier");
  return value;
}

/**
 * Keeps only direct texts from an allowed number to the assistant's line and
 * extracts their text. Returns null for anything else.
 */
export function parseMessageReceived(
  event: Record<string, unknown>,
  config: Pick<Config, "phoneNumber" | "allowedNumbers">,
): LinqIncomingMessage | null {
  const data = object(event.data);
  const chat = object(data.chat);
  const sender = object(data.sender_handle);
  const owner = object(chat.owner_handle);
  if (
    data.direction !== "inbound" ||
    sender.is_me !== false ||
    chat.is_group !== false ||
    data.reconciled_at ||
    owner.handle !== config.phoneNumber ||
    typeof sender.handle !== "string" ||
    !config.allowedNumbers.includes(sender.handle)
  )
    return null;
  if (object(chat.health_status).status === "OPTED_OUT") return null;
  if (!Array.isArray(data.parts)) throw new Error("Missing message parts");
  const parts = data.parts.map(object);
  const text = parts
    .filter((part) => part.type === "text" || part.type === "link")
    .map((part) => {
      if (typeof part.value !== "string") throw new Error("Invalid text part");
      return part.value;
    })
    .join("\n")
    .trim();
  const hasAttachments = parts.some(
    (part) => part.type !== "text" && part.type !== "link",
  );
  if (!text && !hasAttachments) return null;
  return {
    eventId: id(event.event_id),
    messageId: id(data.id),
    chatId: id(chat.id),
    text,
    hasAttachments,
  };
}
