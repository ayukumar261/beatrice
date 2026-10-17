import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createGarageStore, garageConfig } from "./garage";

test(
  "Garage round-trip uses private storage and preserves the image content type",
  { skip: !process.env.GARAGE_ENDPOINT },
  async () => {
    const config = garageConfig()!;
    const store = createGarageStore(config);
    const key = `tests/${randomUUID()}.png`;
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=",
      "base64",
    );
    try {
      assert.equal(await store.has(key), false);
      await store.put(key, image, "image/png");
      assert.equal(await store.has(key), true);
      const result = await store.get(key);
      assert.deepEqual(result.body, image);
      assert.equal(result.contentType, "image/png");
      const publicResponse = await fetch(
        `${config.endpoint}/${config.bucket}/${key}`,
      );
      assert.equal(publicResponse.status, 403);
      await publicResponse.body?.cancel();
    } finally {
      await store.delete(key);
      store.close();
    }
  },
);
