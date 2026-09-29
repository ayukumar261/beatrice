export interface Config {
  apiKey: string;
  webhookSecret: string;
  phoneNumber: string;
  allowedNumbers: string[];
  host: string;
  port: number;
  temporalAddress: string;
}

export function phoneNumber(value: string): string {
  const normalized = value.replace(/[\s().-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new Error(
      "Phone numbers must include the country code, e.g. +15551234567",
    );
  }
  return normalized;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  for (const key of [
    "LINQ_API_KEY",
    "LINQ_WEBHOOK_SECRET",
    "LINQ_PHONE_NUMBER",
    "LINQ_ALLOWED_NUMBERS",
  ]) {
    if (!env[key]?.trim())
      throw new Error(
        `${key} is not set. See .env.example; pnpm linq:setup saves the webhook values.`,
      );
  }
  const port = Number(env.LINQ_PORT ?? "3001");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("LINQ_PORT must be an integer between 1 and 65535");
  }
  const line = phoneNumber(env.LINQ_PHONE_NUMBER!);
  const allowedNumbers = env.LINQ_ALLOWED_NUMBERS!.split(",").map(phoneNumber);
  if (allowedNumbers.includes(line))
    throw new Error(
      "Your personal phone and LINQ_PHONE_NUMBER must be different numbers",
    );
  return {
    apiKey: env.LINQ_API_KEY!,
    webhookSecret: env.LINQ_WEBHOOK_SECRET!,
    phoneNumber: line,
    allowedNumbers,
    host: env.LINQ_HOST ?? "127.0.0.1",
    port,
    temporalAddress: env.TEMPORAL_ADDRESS ?? "localhost:7233",
  };
}
