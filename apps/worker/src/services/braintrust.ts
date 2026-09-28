import { Context } from "@temporalio/activity";
import { flush, initLogger } from "braintrust";

const logger = initLogger({
  projectName: process.env.BRAINTRUST_PROJECT ?? "platform",
  apiKey: process.env.BRAINTRUST_API_KEY,
});

/**
 * Opens the root `task` span for one conversation and returns its exported
 * handle. Activities pass the handle as `parent` so every turn of the
 * conversation nests under a single row in Braintrust.
 */
export async function startTrace(input: { agent: string }): Promise<string> {
  const workflowId =
    Context.current().info.workflowExecution?.workflowId ?? "unknown";
  const span = logger.startSpan({ name: workflowId, type: "task" });
  span.log({ metadata: { agent: input.agent, workflowId } });
  const trace = await span.export();
  span.end();
  await flush();
  return trace;
}

export async function flushLogs(): Promise<void> {
  await flush();
}
