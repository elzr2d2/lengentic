/**
 * The negative half of `p2.stale-on-kill`: a standalone TypeScript host that starts a Run
 * through the real `@lengentic/telemetry-sdk` public entry, completes it normally, calls
 * `shutdown()`, and exits cleanly — never killed.
 *
 * Its Run must never derive STALE, however long the test waits afterwards. Without this
 * fixture the suite could pass on an implementation that reports every idle-enough Run as
 * STALE regardless of its stored status, which is the false positive `stale.ts`'s own guard
 * (`status == RUNNING`) exists to prevent — the direction that destroys trust in the Run
 * Explorer, per the work packet.
 *
 * argv[2] — TCP port the live API is listening on (127.0.0.1).
 * argv[3] — workflowVersion, so stdout/the resulting row can be told apart from other
 *           fixtures in this suite.
 */
import { createTelemetryClient } from '@lengentic/telemetry-sdk';

/**
 * Returns `value` narrowed to `string`. A plain `if (value === undefined) throw` at module
 * scope does not narrow the module-scope binding inside `main()` below — the two sit in
 * different closures — so the check and the narrowing are done together here instead.
 */
function requireArg(value: string | undefined, name: string): string {
  if (value === undefined) {
    throw new Error(`usage: completed-run.ts <port> <workflowVersion> — missing ${name}`);
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

  const run = telemetry.startRun({ workflowName: 'stale-on-kill-completed', workflowVersion });
  const step = run.startStep({ name: 'do-work', agentName: 'complete-me-agent', type: 'execute' });
  step.complete();
  run.complete();

  await telemetry.shutdown();

  const stats = telemetry.stats();
  process.stdout.write(`RUN-COMPLETED ${run.runId} delivered=${stats.delivered}\n`);
}

void main();
