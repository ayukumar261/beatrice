import { Context } from "@temporalio/activity";
import { currentSpan, flush, initLogger, traced, updateSpan } from "braintrust";

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

export interface OutcomeInput {
  workflowId: string;
  agent: string;
  status: "completed" | "failed";
  steps?: number;
  trace?: string;
  output?: string;
}

/**
 * Durable workflow-outcome record. Runs as an activity so Temporal retries the
 * logging itself — "retries exhausted" is always visible in Braintrust, and the
 * flush before returning makes the record safe once the activity completes.
 */
export async function record(input: OutcomeInput): Promise<void> {
  await traced(
    async () => {
      currentSpan().log({
        output: input.status,
        metadata: {
          kind: "workflow-outcome",
          workflowId: input.workflowId,
          agent: input.agent,
          steps: input.steps,
        },
      });
    },
    { name: "record", type: "function", parent: input.trace },
  );

  if (input.trace) {
    // The run's row in the Logs table shows the final answer (or the failure).
    updateSpan({ exported: input.trace, output: input.output ?? input.status });
  }
  await flush();
}

export async function flushLogs(): Promise<void> {
  await flush();
}
