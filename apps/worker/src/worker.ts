import { NativeConnection, Worker } from "@temporalio/worker";

import { TASK_QUEUE } from "@repo/types";
import { flushLogs, startTrace } from "./services/braintrust";
import { createGarageStore, garageConfig } from "./services/garage";
import { createImageActivities } from "./services/images";
import { createLinqActivities } from "./services/linq";
import { createOpenRouterActivities } from "./services/openrouter";
import { executeTool } from "./tools";

async function main(): Promise<void> {
  const storageConfig = garageConfig();
  const store = storageConfig ? createGarageStore(storageConfig) : undefined;
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  });

  try {
    const worker = await Worker.create({
      connection,
      taskQueue: TASK_QUEUE,
      workflowsPath: require.resolve("./workflows"),
      activities: {
        ...createOpenRouterActivities(undefined, undefined, store),
        ...createImageActivities(store),
        executeTool,
        startTrace,
        ...createLinqActivities(),
      },
    });

    console.log(`worker polling task queue "${TASK_QUEUE}"`);
    await worker.run();
  } finally {
    store?.close();
    await flushLogs();
    await connection.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
