/**
 * The abandoned half of `p2.stale-on-kill`: a standalone TypeScript host, run as its own
 * OS process, that starts a Run and a Step through the real `@lengentic/telemetry-sdk`
 * public entry, `flush()`es so the start events are durably delivered to the live API, and
 * then hangs forever — it never calls `run.complete()` and never calls `shutdown()`.
 *
 * The parent test process kills this one with SIGKILL once it has printed `RUN-STARTED`,
 * which is the only signal the parent trusts that the start event actually reached
 * PostgreSQL. Nothing here catches the kill; there is nothing to catch — SIGKILL cannot be
 * handled by the target process on any platform.
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
    throw new Error(`usage: abandoned-run.ts <port> <workflowVersion> — missing ${name}`);
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

  const run = telemetry.startRun({ workflowName: 'stale-on-kill-abandoned', workflowVersion });
  run.startStep({ name: 'do-work', agentName: 'kill-me-agent', type: 'execute' });

  // Force delivery now rather than waiting on the flush interval, and confirm it actually
  // reached the API. Printing RUN-STARTED before this would race the parent's SIGKILL
  // against a start event still sitting in the SDK's queue — exactly the "green that lies"
  // the work packet warns about, where a run killed before it exists at all would leave the
  // parent asserting against a 404 instead of a real abandoned Run.
  await telemetry.flush();
  const stats = telemetry.stats();
  if (stats.delivered < 2) {
    process.stderr.write(
      `DELIVERY-INCOMPLETE ${JSON.stringify(stats)} — expected 2 delivered (run.started, step.started)\n`,
    );
    process.exit(1);
  }

  // Flushed line, parsed by the parent's line reader. The parent SIGKILLs this process the
  // moment it sees this — everything after this line runs only until that signal lands.
  process.stdout.write(`RUN-STARTED ${run.runId}\n`);

  // Never resolves. No `run.complete()`, no `shutdown()` — this process is meant to die
  // mid-run, not to exit on its own.
  await new Promise<never>(() => {});
}

void main();
