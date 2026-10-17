import assert from "node:assert/strict";
import { test } from "node:test";
import { MockActivityEnvironment } from "@temporalio/testing";
import { ApplicationFailure } from "@temporalio/common";
import { MAX_IMAGE_BYTES } from "@repo/types";
import type {
  LinqIncomingMessage,
  Message,
  UserContentPart,
} from "@repo/types";
import { createImageActivities, resolveImages } from "./images";
import type { GarageStore } from "./garage";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=",
  "base64",
);
const incoming: LinqIncomingMessage = {
  eventId: "event",
  messageId: "message",
  chatId: "chat",
  text: "What is this?",
  hasAttachments: true,
  images: [
    {
      id: "photo",
      url: "https://cdn.linqapp.com/photo.png?signature=secret",
      mimeType: "image/png",
    },
  ],
};

function memoryStore() {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const store: GarageStore = {
    async has(key) {
      return objects.has(key);
    },
    async put(key, body, contentType) {
      objects.set(key, { body: Buffer.from(body), contentType });
    },
    async get(key) {
      return objects.get(key)!;
    },
    async delete(key) {
      objects.delete(key);
    },
    close() {},
  };
  return { store, objects };
}

test("imports images once, preserves order, and resolves private references only at model time", async () => {
  const { store, objects } = memoryStore();
  let downloads = 0;
  const activity = createImageActivities(store, async (_url, options) => {
    downloads++;
    assert.equal(options?.redirect, "error");
    return new Response(png);
  });
  const env = new MockActivityEnvironment();
  const parts = (await env.run(activity.prepareLinqImages, [
    incoming,
  ])) as UserContentPart[];
  assert.deepEqual(
    await env.run(activity.prepareLinqImages, [incoming]),
    parts,
  );
  assert.equal(downloads, 1);
  assert.equal(objects.size, 1);
  assert.equal(parts[0]?.type, "text");
  assert.equal(parts[1]?.type, "stored_image");
  assert.ok(!JSON.stringify(parts).includes("secret"));
  assert.ok(!JSON.stringify(parts).includes("base64"));
  const messages: Message[] = [{ role: "user", content: parts }];
  const wire = await resolveImages(messages, store);
  assert.deepEqual(wire, [
    {
      role: "user",
      content: [
        { type: "text", text: incoming.text },
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${png.toString("base64")}` },
        },
      ],
    },
  ]);
  assert.deepEqual(
    messages[0]?.content,
    parts,
    "Keep data URLs out of persisted history",
  );
});

test("image downloads reject internal URLs, redirects, unsupported bytes and oversized streams", async (t) => {
  for (const url of [
    "http://cdn.linqapp.com/photo",
    "https://127.0.0.1/photo",
    "https://cdn.linqapp.com.evil.test/photo",
    "https://user@cdn.linqapp.com/photo",
    "https://cdn.linqapp.com:444/photo",
  ]) {
    await t.test(url, async () => {
      const { store } = memoryStore();
      const activity = createImageActivities(store, async () => {
        assert.fail("Must not fetch");
      });
      await assert.rejects(
        new MockActivityEnvironment().run(activity.prepareLinqImages, [
          { ...incoming, images: [{ ...incoming.images![0]!, url }] },
        ]),
        (error: unknown) =>
          error instanceof ApplicationFailure && error.nonRetryable,
      );
    });
  }
  for (const response of [
    new Response("not an image"),
    new Response(png, {
      headers: { "content-length": String(MAX_IMAGE_BYTES + 1) },
    }),
    new Response(new Uint8Array(MAX_IMAGE_BYTES + 1)),
    new Response("expired", { status: 403 }),
  ]) {
    const { store, objects } = memoryStore();
    const activity = createImageActivities(store, async () => response);
    await assert.rejects(
      new MockActivityEnvironment().run(activity.prepareLinqImages, [incoming]),
      (error: unknown) =>
        error instanceof ApplicationFailure && error.nonRetryable,
    );
    assert.equal(objects.size, 0);
  }
});

test("transient download failures retry and image count is bounded before fetching", async () => {
  const { store } = memoryStore();
  let downloads = 0;
  const activity = createImageActivities(store, async () => {
    downloads++;
    return new Response("unavailable", { status: 503 });
  });
  const env = new MockActivityEnvironment();
  await assert.rejects(
    env.run(activity.prepareLinqImages, [incoming]),
    /HTTP 503/,
  );
  await assert.rejects(
    env.run(
      activity.prepareLinqImages,
      Array.from({ length: 5 }, () => incoming),
    ),
    /at most four/,
  );
  assert.equal(downloads, 1);
});

test("follow-ups resolve only the newest four image references", async () => {
  const { store, objects } = memoryStore();
  const messages: Message[] = [];
  for (let i = 0; i < 6; i++) {
    objects.set(String(i), { body: png, contentType: "image/png" });
    messages.push({
      role: "user",
      content: [{ type: "stored_image", key: String(i) }],
    });
  }
  const loaded: string[] = [];
  const wire = await resolveImages(messages, {
    ...store,
    async get(key) {
      loaded.push(key);
      return store.get(key);
    },
  });
  assert.deepEqual(loaded, ["2", "3", "4", "5"]);
  assert.match(JSON.stringify(wire[0]), /older image was omitted/);
  assert.equal(JSON.stringify(wire).split("data:image/png").length - 1, 4);
});
