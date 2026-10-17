import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMessageReceived } from "./message-received";

const config = {
  phoneNumber: "+15550000001",
  allowedNumbers: ["+15550000002"],
};
const event = {
  event_id: "event",
  data: {
    id: "message",
    direction: "inbound",
    sender_handle: { handle: config.allowedNumbers[0], is_me: false },
    chat: {
      id: "chat",
      is_group: false,
      owner_handle: { handle: config.phoneNumber },
      health_status: { status: "HEALTHY" },
    },
    parts: [
      { type: "text", value: "What is this?" },
      {
        type: "media",
        id: "image",
        url: "https://cdn.linqapp.com/photo.png",
        mime_type: "image/png",
      },
      {
        type: "media",
        id: "audio",
        url: "https://cdn.linqapp.com/audio.mp3",
        mime_type: "audio/mpeg",
      },
    ],
  },
};

test("allowed image attachments survive parsing, including photo-only messages", () => {
  const parsed = parseMessageReceived(event, config)!;
  assert.equal(parsed.text, "What is this?");
  assert.deepEqual(parsed.images, [
    {
      id: "image",
      url: "https://cdn.linqapp.com/photo.png",
      mimeType: "image/png",
    },
  ]);
  assert.equal(parsed.hasAttachments, true);
  assert.equal(parsed.hasUnsupportedAttachments, true);
  const photoOnly = parseMessageReceived(
    { ...event, data: { ...event.data, parts: event.data.parts.slice(1, 2) } },
    config,
  )!;
  assert.equal(photoOnly.text, "");
  assert.equal(photoOnly.images?.length, 1);
  assert.equal(photoOnly.hasUnsupportedAttachments, undefined);
});

test("sender filtering still applies before any attachment handling", () => {
  assert.equal(
    parseMessageReceived(
      {
        ...event,
        data: {
          ...event.data,
          sender_handle: { handle: "+15559999999", is_me: false },
        },
      },
      config,
    ),
    null,
  );
});
