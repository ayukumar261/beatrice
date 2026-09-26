import { NativeConnection, Worker } from "@temporalio/worker";

import { TASK_QUEUE } from "@repo/types";
import { flushLogs, record, startTrace } from "./services/braintrust";
import { createLinqActivities } from "./services/linq";
import { createOpenRouterActivities } from "./services/openrouter";
import { executeTool } from "./tools";

async function main(): Promise<void> {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  });

  try {
    const worker = await Worker.create({
      connection,
      taskQueue: TASK_QUEUE,
      workflowsPath: require.resolve("./workflows"),
      activities: {
        ...createOpenRouterActivities(),
        executeTool,
        startTrace,
        record,
        ...createLinqActivities(),
      },
    });

    console.log(`worker polling task queue "${TASK_QUEUE}"`);
    await worker.run();
  } finally {
    await flushLogs();
    await connection.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
