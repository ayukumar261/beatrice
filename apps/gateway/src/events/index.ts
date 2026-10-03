import type { LinqIncomingMessage } from "@repo/types";

import type { Config } from "../config";
import { parseMessageReceived } from "./message-received";

/** Pinned by `pnpm linq:setup`; the event parsers assume this payload shape. */
const WEBHOOK_VERSION = "2026-02-03";

/**
 * Checks a verified webhook's envelope and routes it by event type. Returns
 * null for events Beatrice ignores; throws when the payload is malformed.
 */
export function parseInboundEvent(
  value: unknown,
  config: Pick<Config, "phoneNumber" | "allowedNumbers">,
): LinqIncomingMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid webhook object");
  const event = value as Record<string, unknown>;
  if (typeof event.event_type !== "string")
    throw new Error("Missing event type");
  if (event.webhook_version !== WEBHOOK_VERSION)
    throw new Error(`Use webhook version ${WEBHOOK_VERSION}`);

  switch (event.event_type) {
    case "message.received":
      return parseMessageReceived(event, config);
    default:
      return null;
  }
}
