import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { MAX_IMAGE_BYTES } from "@repo/types";

export interface GarageConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function garageConfig(env = process.env): GarageConfig | undefined {
  const names = [
    "GARAGE_ENDPOINT",
    "GARAGE_BUCKET",
    "GARAGE_ACCESS_KEY_ID",
    "GARAGE_SECRET_ACCESS_KEY",
  ] as const;
  if (!names.some((name) => env[name])) return undefined;
  for (const name of names) {
    if (!env[name])
      throw new Error(
        `${name} is required for image storage. Run pnpm garage:setup.`,
      );
  }
  return {
    endpoint: env.GARAGE_ENDPOINT!,
    bucket: env.GARAGE_BUCKET!,
    accessKeyId: env.GARAGE_ACCESS_KEY_ID!,
    secretAccessKey: env.GARAGE_SECRET_ACCESS_KEY!,
  };
}

/** Path-style S3 access to the private media bucket. No public ACLs or URLs. */
export function createGarageStore(config: GarageConfig, client?: S3Client) {
  const s3 =
    client ??
    new S3Client({
      endpoint: config.endpoint,
      region: "garage",
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      // Recover stale keep-alive sockets after Garage restarts; the enclosing
      // activity deadline still bounds these retries.
      maxAttempts: 3,
    });
  const params = (key: string) => ({ Bucket: config.bucket, Key: key });
  const options = (signal?: AbortSignal) => ({
    abortSignal: signal ?? AbortSignal.timeout(30_000),
  });
  return {
    async put(
      key: string,
      body: Uint8Array,
      contentType: string,
      signal?: AbortSignal,
    ) {
      if (!body.length || body.length > MAX_IMAGE_BYTES)
        throw new Error("Invalid image size");
      await s3.send(
        new PutObjectCommand({
          ...params(key),
          Body: body,
          ContentType: contentType,
        }),
        options(signal),
      );
    },
    async has(key: string, signal?: AbortSignal): Promise<boolean> {
      try {
        await s3.send(new HeadObjectCommand(params(key)), options(signal));
        return true;
      } catch (error) {
        if (
          (error as { $metadata?: { httpStatusCode?: number } }).$metadata
            ?.httpStatusCode === 404
        )
          return false;
        throw error;
      }
    },
    async get(key: string, signal?: AbortSignal) {
      const result = await s3.send(
        new GetObjectCommand(params(key)),
        options(signal),
      );
      if (!result.Body) throw new Error("Image object has no body");
      const body = await readLimited(result.Body as AsyncIterable<Uint8Array>);
      return {
        body,
        contentType: result.ContentType ?? "application/octet-stream",
      };
    },
    async delete(key: string) {
      await s3.send(new DeleteObjectCommand(params(key)), options());
    },
    close() {
      s3.destroy();
    },
  };
}

export type GarageStore = ReturnType<typeof createGarageStore>;

/** Enforce the limit while streaming, including when Content-Length is absent. */
export async function readLimited(
  stream: AsyncIterable<Uint8Array>,
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > MAX_IMAGE_BYTES)
      throw new Error("Image exceeds the 5 MiB limit");
    chunks.push(chunk);
  }
  if (!size) throw new Error("Image is empty");
  return Buffer.concat(chunks);
}
