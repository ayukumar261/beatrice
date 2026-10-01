import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Linq from "@linqapp/sdk";
import { phoneNumber } from "../src/config";

const envPath = resolve(__dirname, "../../../.env");

function saveEnv(values: Record<string, string>): void {
  let content = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${JSON.stringify(value)}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    content = pattern.test(content)
      ? content.replace(pattern, () => line)
      : `${content.trimEnd()}\n${line}\n`;
  }
  writeFileSync(envPath, content, { mode: 0o600 });
  chmodSync(envPath, 0o600);
}

async function main(): Promise<void> {
  const apiKey = process.env.LINQ_API_KEY;
  if (!apiKey)
    throw new Error(
      "Add LINQ_API_KEY to the root .env file, then run pnpm linq:setup https://YOUR-HOST/webhooks/linq",
    );
  const target = new URL(process.argv[2] ?? "");
  if (
    target.protocol !== "https:" ||
    target.pathname !== "/webhooks/linq" ||
    target.username ||
    target.password ||
    target.hash
  ) {
    throw new Error("Provide an HTTPS URL ending in /webhooks/linq");
  }
  target.searchParams.set("version", "2026-02-03");
  const allowed = process.env.LINQ_ALLOWED_NUMBERS?.split(",").map(phoneNumber);
  if (!allowed?.length)
    throw new Error(
      "Set LINQ_ALLOWED_NUMBERS to your personal phone number in E.164 format",
    );
  const client = new Linq({ apiKey, timeout: 15_000, maxRetries: 0 });
  const { phone_numbers: lines } = await client.phoneNumbers.list();
  const line = process.env.LINQ_PHONE_NUMBER
    ? phoneNumber(process.env.LINQ_PHONE_NUMBER)
    : lines.length === 1
      ? lines[0]!.phone_number
      : undefined;
  if (!line || !lines.some((entry) => entry.phone_number === line)) {
    throw new Error(
      `Set LINQ_PHONE_NUMBER to a line in your Linq account. Available lines: ${lines.map((entry) => entry.phone_number).join(", ") || "none — provision a number in the Linq dashboard first"}`,
    );
  }
  if (allowed.includes(line))
    throw new Error(
      "LINQ_PHONE_NUMBER is the assistant's line; LINQ_ALLOWED_NUMBERS must contain your separate personal phone",
    );
  const { subscriptions } = await client.webhookSubscriptions.list();
  const existing =
    subscriptions.find(
      (entry) => entry.id === process.env.LINQ_WEBHOOK_SUBSCRIPTION_ID,
    ) ?? subscriptions.find((entry) => entry.target_url === target.href);
  const params = {
    target_url: target.href,
    phone_numbers: [line],
    subscribed_events: ["message.received" as const],
  };
  if (existing) {
    if (!process.env.LINQ_WEBHOOK_SECRET)
      throw new Error(
        "This subscription already exists. Add its signing secret to LINQ_WEBHOOK_SECRET; Linq cannot retrieve it again.",
      );
    await client.webhookSubscriptions.update(existing.id, {
      ...params,
      is_active: true,
    });
    saveEnv({
      LINQ_PHONE_NUMBER: line,
      LINQ_WEBHOOK_SUBSCRIPTION_ID: existing.id,
    });
  } else {
    const subscription = await client.webhookSubscriptions.create(params);
    // Persist the secret immediately; it is returned only at creation time.
    saveEnv({
      LINQ_PHONE_NUMBER: line,
      LINQ_WEBHOOK_SUBSCRIPTION_ID: subscription.id,
      LINQ_WEBHOOK_SECRET: subscription.signing_secret,
    });
  }
  console.log(`Linq webhook configured at ${target.href}`);
  console.log(
    "Configuration saved to the root .env; the signing secret was not printed.",
  );
  console.log(
    `Restart pnpm dev, then text ${line} from your allowed personal phone.`,
  );
}

main().catch((error: unknown) => {
  const apiMessage =
    error instanceof Linq.APIError &&
    error.error &&
    "message" in error.error &&
    typeof error.error.message === "string"
      ? error.error.message
          .replaceAll(process.env.LINQ_API_KEY ?? "", "[redacted]")
          .slice(0, 500)
      : undefined;
  console.error(
    error instanceof Linq.APIError
      ? `Linq setup failed (HTTP ${error.status ?? "unknown"})${apiMessage ? `: ${apiMessage}` : ""}`
      : error instanceof Error
        ? error.message
        : "Linq setup failed",
  );
  process.exitCode = 1;
});
