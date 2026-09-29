import assert from "node:assert/strict";
import { test } from "node:test";
import { phoneNumber, readConfig } from "./config";

test("normalizes formatted international numbers and rejects ambiguous local numbers", () => {
  assert.equal(phoneNumber("+1 (555) 000-0002"), "+15550000002");
  assert.throws(() => phoneNumber("5550000002"));
});

test("fails closed when incompletely configured", () => {
  assert.throws(() => readConfig({}), /LINQ_API_KEY/);
  assert.throws(
    () => readConfig({ LINQ_API_KEY: "key" }),
    /LINQ_WEBHOOK_SECRET/,
  );
  const env = {
    LINQ_API_KEY: "key",
    LINQ_WEBHOOK_SECRET: "secret",
    LINQ_PHONE_NUMBER: "+15550000001",
    LINQ_ALLOWED_NUMBERS: "+15550000002",
  };
  assert.equal(readConfig(env).port, 3001);
  assert.equal(readConfig(env).temporalAddress, "localhost:7233");
  assert.throws(
    () => readConfig({ ...env, LINQ_ALLOWED_NUMBERS: env.LINQ_PHONE_NUMBER }),
    /different/,
  );
  assert.throws(() => readConfig({ ...env, LINQ_ALLOWED_NUMBERS: "" }));
  assert.throws(() => readConfig({ ...env, LINQ_PORT: "NaN" }));
});
