/**
 * Phase 2 Definition of Done, run for real: "running the script with the API down does not
 * crash the script."
 *
 * Deliberately a separate process with the real HTTP transport, the real clock and the real
 * timers. Nothing here is a test double — an in-process test with a failing transport double
 * proves the SDK handles a transport that reports failure, which is a weaker claim than the
 * one the DoD makes.
 *
 * argv[2] is a TCP port nothing is listening on, so every request is refused.
 */
import { createTelemetryClient } from '../../src/index';

const port = process.argv[2];

async function main(): Promise<void> {
  const telemetry = createTelemetryClient({
    endpoint: `http://127.0.0.1:${port}`,
    maxRetries: 1,
    initialBackoffMs: 10,
    maxBackoffMs: 10,
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 5_000,
    flushIntervalMs: 50,
  });

  const run = telemetry.startRun({ workflowName: 'demo-workflow', workflowVersion: 'a1b2c3d' });
  const step = run.startStep({ name: 'execute', agentName: 'demo-agent', type: 'execute' });
  step.complete();
  run.complete();

  await telemetry.shutdown();

  const stats = telemetry.stats();
  process.stdout.write(
    `SCRIPT-COMPLETED recorded=${stats.recorded} delivered=${stats.delivered} undeliverable=${stats.droppedUndeliverable}\n`,
  );
}

// Nothing catches this on purpose. If the SDK throws or rejects anywhere in the flow above,
// Node exits non-zero on the unhandled rejection and the test that spawned this fails —
// which is exactly the failure the DoD checkbox is about.
void main();
