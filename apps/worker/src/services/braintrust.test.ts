import assert from "node:assert/strict";
import { test } from "node:test";
import { MockActivityEnvironment } from "@temporalio/testing";
import { _exportsForTestingOnly, setFetch, traced } from "braintrust";
import { startTrace } from "./braintrust";

test("each conversation gets one root span that every later span nests under", async (t) => {
  // Braintrust registers the project over HTTP before logging; answer that
  // locally and fail on anything else so the test never reaches the network.
  setFetch((async (url: string) => {
    if (String(url).endsWith("/api/project/register"))
      return Response.json({ project: { id: "project-1", name: "test" } });
    throw new Error(`unexpected network call: ${url}`);
  }) as typeof fetch);
  await _exportsForTestingOnly.simulateLoginForTests();
  const logs = _exportsForTestingOnly.useTestBackgroundLogger();
  t.after(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
    _exportsForTestingOnly.simulateLogoutForTests();
  });

  const env = new MockActivityEnvironment({
    workflowExecution: { workflowId: "linq:chat-1", runId: "run-1" },
  });
  const trace = (await env.run(startTrace, { agent: "beatrice-sms" })) as string;
  for (const turn of [0, 1]) {
    await traced(async () => undefined, {
      name: `turn-${turn}`,
      type: "llm",
      parent: trace,
    });
  }

  // The SDK types rows as a union of every row kind; these are all spans.
  const [root, ...turns] = (await logs.drain()) as Record<string, unknown>[];
  const attributes = root?.span_attributes as Record<string, unknown>;
  assert.equal(attributes.name, "linq:chat-1");
  assert.equal(attributes.type, "task");
  assert.deepEqual(root?.metadata, {
    agent: "beatrice-sms",
    workflowId: "linq:chat-1",
  });
  assert.equal(root?.span_parents, undefined);
  assert.equal(turns.length, 2);
  for (const span of turns) {
    assert.deepEqual(span.span_parents, [root?.span_id]);
    assert.equal(span.root_span_id, root?.root_span_id);
  }
});
