import { once } from "node:events";
import { Client, Connection } from "@temporalio/client";
import { LINQ_CONVERSATION, LINQ_MESSAGE, TASK_QUEUE } from "@repo/types";

import { readConfig } from "./config";
import { createLinqServer } from "./server";

async function main(): Promise<void> {
  const config = readConfig();
  const connection = await Connection.connect({
    address: config.temporalAddress,
  });
  const client = new Client({ connection });

  const server = createLinqServer(config, async (message) => {
    await connection.withDeadline(Date.now() + 5_000, () =>
      client.workflow.signalWithStart(LINQ_CONVERSATION, {
        workflowId: `linq:${message.chatId}`,
        taskQueue: TASK_QUEUE,
        args: [],
        signal: LINQ_MESSAGE,
        signalArgs: [message],
      }),
    );
  });
  server.listen(config.port, config.host);
  await once(server, "listening");
  console.log(
    `Linq webhooks listening on http://${config.host}:${config.port}/webhooks/linq`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
