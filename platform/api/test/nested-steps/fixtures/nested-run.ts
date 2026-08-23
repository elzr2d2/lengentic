/**
 * The Phase 2 DoD prose header, driven exactly as it is written (`MVP_PLAN_V3.md:1599-1601`):
 *
 *   "A standalone TypeScript script can start a Run with a `workflowVersion`, create nested
 *    Steps, complete the Run, send everything through the public SDK, `shutdown()`, and exit
 *    cleanly."
 *
 * Three levels deep — `root -> child -> grandchild` — plus a second child of the root, so the
 * shape has both a chain and a branch. The script never names a `parentStepId`: nesting is
 * expressed only by *which handle* `startStep` is called on, and resolving that into a stored
 * parent is the SDK's job. That is the whole point of this fixture. Until it existed,
 * `<StepHandle>.startStep(...)` was called in exactly one place in the repository — a vitest
 * worker against a fake transport — so flattening every nested step to a root
 * (`platform/telemetry-sdk/src/handles.ts`, `startStep: (child) => createStep(recorder, runId,
 * null, child)`) left the entire API integration suite green at 40/40.
 *
 * Nothing here imports the platform. `@lengentic/telemetry-sdk` is resolved by package name
 * through its own `exports` map, which is the public entry an external consumer gets and the
 * resolution path `pretest:integration` builds `dist/` for.
 *
 * Adapted from the Phase 2 phase-gate Tester's host, proven against a live API and a real
 * database at `2ebf0d8` (`.artifacts/evidence/2/phase-gate-2/tester/host/nested-run.ts`,
 * results in that pass's README §7).
 *
 * argv[2] — TCP port the live API is listening on (127.0.0.1).
 * argv[3] — workflowVersion, so the resulting row can be told apart from other fixtures.
 */
import { createTelemetryClient } from '@lengentic/telemetry-sdk';

/**
 * Returns `value` narrowed to `string`. A plain `if (value === undefined) throw` at module
 * scope does not narrow the module-scope binding inside `main()` below — the two sit in
 * different closures — so the check and the narrowing are done together here instead.
 */
function requireArg(value: string | undefined, name: string): string {
  if (value === undefined) {
    throw new Error(`usage: nested-run.ts <port> <workflowVersion> — missing ${name}`);
  }
  return value;
}

const port = requireArg(process.argv[2], 'port');
const workflowVersion = requireArg(process.argv[3], 'workflowVersion');

async function main(): Promise<void> {
  const telemetry = createTelemetryClient({
    endpoint: `http://127.0.0.1:${port}`,
    flushIntervalMs: 20,
    maxRetries: 2,
    initialBackoffMs: 20,
    maxBackoffMs: 100,
    requestTimeoutMs: 2_000,
  });

  const run = telemetry.startRun({ workflowName: 'nested-steps-host', workflowVersion });

  const root = run.startStep({ name: 'root-step', agentName: 'nested-agent', type: 'execute' });
  const child = root.startStep({ name: 'child-step', agentName: 'nested-agent', type: 'tool' });
  const grandchild = child.startStep({
    name: 'grandchild-step',
    agentName: 'nested-agent',
    type: 'llm',
  });
  const sibling = root.startStep({ name: 'sibling-step', agentName: 'nested-agent', type: 'tool' });

  grandchild.complete();
  child.complete();
  sibling.complete({ status: 'FAILED' });
  root.complete();
  run.complete();

  // The DoD's `shutdown()`. Everything above is queued, so this is the only thing that makes
  // the ten events real; the process exiting before it resolves would leave the parent test
  // asserting against a run that had never arrived.
  await telemetry.shutdown();

  const stats = telemetry.stats();

  // The ids the SDK handed back, which is the second observable interface the parent test
  // compares the stored rows against. It is deliberately not the API's own answer: reading the
  // parent chain out of the response and checking it against itself would agree with any
  // implementation. The parent knows which id is the root, which is the child and which is the
  // grandchild only because this line says so.
  process.stdout.write(
    `HOST-OK runId=${run.runId} root=${root.stepId} child=${child.stepId} ` +
      `grandchild=${grandchild.stepId} sibling=${sibling.stepId} ` +
      `recorded=${String(stats.recorded)} delivered=${String(stats.delivered)} ` +
      `undeliverable=${String(stats.droppedUndeliverable)}\n`,
  );
}

void main();
