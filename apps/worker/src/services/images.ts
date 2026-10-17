import { createHash } from "node:crypto";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import {
  IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_TURN,
} from "@repo/types";
import type {
  LinqIncomingMessage,
  Message,
  UserContentPart,
} from "@repo/types";
import { readLimited } from "./garage";
import type { GarageStore } from "./garage";

function invalid(message: string): never {
  throw ApplicationFailure.nonRetryable(message, "InvalidImage");
}

function validateUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid("Invalid image URL");
  }
  // Fetch only the provider's media CDN. Do not follow redirects into the LAN.
  if (
    url.protocol !== "https:" ||
    url.hostname !== "cdn.linqapp.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  )
    invalid("Image URL must use the Linq HTTPS media CDN");
  return url;
}

export function imageMimeType(bytes: Buffer): string {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii")))
    return "image/gif";
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  return invalid("Unsupported image bytes; send JPEG, PNG, GIF or WebP");
}

export function createImageActivities(store?: GarageStore, fetchImage = fetch) {
  return {
    async prepareLinqImages(
      batch: LinqIncomingMessage[],
    ): Promise<UserContentPart[]> {
      if (!store)
        throw ApplicationFailure.nonRetryable(
          "Garage image storage is not configured",
          "ImageStorageUnavailable",
        );
      if (
        batch.reduce((count, item) => count + (item.images?.length ?? 0), 0) >
        MAX_IMAGES_PER_TURN
      )
        invalid("Send at most four images per turn");
      const ctx = Context.current();
      const signal = AbortSignal.any([
        ctx.cancellationSignal,
        AbortSignal.timeout(90_000),
      ]);
      const content: UserContentPart[] = [];
      const heartbeat = setInterval(() => ctx.heartbeat(), 5_000);
      heartbeat.unref();
      try {
        ctx.heartbeat();
        for (const item of batch) {
          if (item.text) content.push({ type: "text", text: item.text });
          if (
            item.hasUnsupportedAttachments ||
            (item.hasAttachments && !item.images?.length)
          )
            content.push({
              type: "text",
              text: "[An attachment was included but is not available to you.]",
            });
          for (const image of item.images ?? []) {
            const url = validateUrl(image.url);
            if (!IMAGE_MIME_TYPES.includes(image.mimeType))
              invalid("Unsupported image type");
            // Stable keys make activity retries safe, even after a CDN URL expires.
            const key = `incoming/${createHash("sha256")
              .update(JSON.stringify([item.chatId, item.messageId, image.id]))
              .digest("hex")}`;
            if (!(await store.has(key, signal))) {
              const response = await fetchImage(url, {
                signal,
                redirect: "error",
              });
              if (!response.ok) {
                await response.body?.cancel();
                if (
                  response.status >= 400 &&
                  response.status < 500 &&
                  ![408, 429].includes(response.status)
                )
                  invalid(
                    `Image download failed (HTTP ${response.status}); please resend the photo`,
                  );
                throw new Error(
                  `Image download failed (HTTP ${response.status})`,
                );
              }
              if (
                Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES
              ) {
                await response.body?.cancel();
                invalid("Image exceeds the 5 MiB limit");
              }
              if (!response.body) invalid("Image download has no body");
              let body: Buffer;
              try {
                body = await readLimited(response.body);
              } catch (error) {
                if (
                  error instanceof Error &&
                  /Image (exceeds|is empty)/.test(error.message)
                )
                  invalid(error.message);
                throw error;
              }
              const contentType = imageMimeType(body);
              await store.put(key, body, contentType, signal);
            }
            content.push({ type: "stored_image", key });
          }
        }
        return content;
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}

/** Resolve only the newest four images, inside the activity, never in history. */
export async function resolveImages(
  messages: Message[],
  store?: GarageStore,
  signal?: AbortSignal,
) {
  const keys = messages.flatMap((message) =>
    message.role === "user" && Array.isArray(message.content)
      ? message.content.flatMap((part) =>
          part.type === "stored_image" ? [part.key] : [],
        )
      : [],
  );
  const recent = new Set(keys.slice(-MAX_IMAGES_PER_TURN));
  const loaded = new Map<string, string>();
  for (const key of recent) {
    if (!store)
      throw ApplicationFailure.nonRetryable(
        "Garage image storage is not configured",
        "ImageStorageUnavailable",
      );
    const { body } = await store.get(key, signal);
    loaded.set(
      key,
      `data:${imageMimeType(body)};base64,${body.toString("base64")}`,
    );
  }
  return messages.map((message) => {
    if (message.role !== "user" || !Array.isArray(message.content))
      return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type === "text") return part;
        const url = loaded.get(part.key);
        return url
          ? { type: "image_url" as const, image_url: { url } }
          : {
              type: "text" as const,
              text: "[An older image was omitted to keep the conversation within its image limit.]",
            };
      }),
    };
  });
}
