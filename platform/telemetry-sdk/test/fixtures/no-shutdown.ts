/**
 * The forgotten-shutdown case. A host records telemetry, never calls `shutdown()`, and
 * reaches the end of its script — with a 60s flush interval armed and an event still in the
 * buffer.
 *
 * The process must exit immediately anyway. If any SDK timer holds a reference on the event
 * loop, this process sits here for a full minute and the spawning test fails on elapsed
 * time. That is the assertion; there is nothing to print but the marker.
 *
 * argv[2] is a TCP port nothing is listening on.
 */
import { createTelemetryClient } from '../../src/index';

const port = process.argv[2];

const telemetry = createTelemetryClient({
  endpoint: `http://127.0.0.1:${port}`,
  // Far longer than the test is willing to wait. An SDK timer that keeps the loop alive
  // cannot hide behind a short interval here.
  flushIntervalMs: 60_000,
});

const run = telemetry.startRun({ workflowName: 'demo-workflow', workflowVersion: 'a1b2c3d' });
run.startStep({ name: 'execute', agentName: 'demo-agent', type: 'execute' });

process.stdout.write('SCRIPT-COMPLETED-WITHOUT-SHUTDOWN\n');
