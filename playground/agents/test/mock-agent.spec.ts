/**
 * Seams under test (agreed against `MockAgent`'s public interface — `mock-agent.ts` exports
 * nothing else a caller is meant to reach):
 *
 *   1. A run emits exactly the five-phase shape the plan names: `Start` (`run.started`),
 *      `Plan`, `Execute` (with a nested `execution_strategy` decision Step and one Step per
 *      task), `Validate`, `Complete` (`run.completed`).
 *   2. The Execute phase actually *follows* `evaluateExecutionStrategy`'s verdict — not just
 *      reports it — proven by telemetry event order under a controlled scheduler, not by
 *      re-checking the evaluator's own twelve rules (`playground/strategy` already owns
 *      that matrix).
 *   3. A Plan (or Execute) failure short-circuits the remaining phases.
 *   4. Same seed → byte-identical telemetry; different seed → different telemetry.
 *
 * Runner: Node's built-in `node:test`/`node:assert/strict` (`playground/package.json`'s
 * `test` script globs `**\/*.spec.ts`), the same convention `playground/providers` and
 * `playground/determinism` already use.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MockAgent } from '../index';
import { FakeScheduler } from './support/fake-scheduler';
import { RecordingTransport, type RecordedEnvelope } from './support/recording-transport';

function eventsOf(transport: RecordingTransport, type: string): RecordedEnvelope[] {
  return transport.allEvents.filter((event) => event.type === type);
}

function namesOf(transport: RecordingTransport, type: 'step.started'): string[] {
  return eventsOf(transport, type).map((event) => (event.payload as { name: string }).name);
}

/** Step *names* (not ids) that have a matching `step.completed` so far, in the order they
 *  completed — the readable form every "X has/has not completed yet" checkpoint below
 *  needs, since `step.completed` events carry only the step's `entityId`. */
function completedNames(transport: RecordingTransport): string[] {
  const nameById = new Map<string, string>();
  for (const event of eventsOf(transport, 'step.started')) {
    nameById.set(event.entityId, (event.payload as { name: string }).name);
  }
  return eventsOf(transport, 'step.completed')
    .map((event) => nameById.get(event.entityId))
    .filter((name): name is string => name !== undefined);
}

void describe('MockAgent — five-step workflow shape', () => {
  void it('emits Start, Plan, Execute (decision + one task step), Validate, Complete for the default single task', async () => {
    const transport = new RecordingTransport();
    const agent = new MockAgent({ seed: 1, telemetryConfig: { transport } });

    const result = await agent.run();

    assert.equal(result.status, 'COMPLETED');
    assert.equal(eventsOf(transport, 'run.started').length, 1);
    assert.equal(eventsOf(transport, 'run.completed').length, 1);
    assert.deepEqual(namesOf(transport, 'step.started'), [
      'plan',
      'execute',
      'execution_strategy',
      'default',
      'validate',
    ]);

    const executeStarted = eventsOf(transport, 'step.started').find(
      (event) => (event.payload as { name: string }).name === 'execute',
    );
    const decisionStarted = eventsOf(transport, 'step.started').find(
      (event) => (event.payload as { name: string }).name === 'execution_strategy',
    );
    const taskStarted = eventsOf(transport, 'step.started').find(
      (event) => (event.payload as { name: string }).name === 'default',
    );
    assert.ok(executeStarted && decisionStarted && taskStarted);
    // The decision Step and the task Step both nest under Execute — proven structurally
    // (`parentStepId`), not by event order alone.
    assert.equal(
      (decisionStarted.payload as { parentStepId: string | null }).parentStepId,
      executeStarted.entityId,
    );
    assert.equal(
      (taskStarted.payload as { parentStepId: string | null }).parentStepId,
      executeStarted.entityId,
    );
    // Plan and Validate are top-level (root) Steps, same as Execute.
    const planStarted = eventsOf(transport, 'step.started').find(
      (event) => (event.payload as { name: string }).name === 'plan',
    );
    assert.equal((planStarted?.payload as { parentStepId: string | null }).parentStepId, null);
  });

  void it('carries the execution_strategy decision (mode, evaluatorVersion, awarenessContext) as the decision Step metadata', async () => {
    const transport = new RecordingTransport();
    const agent = new MockAgent({ seed: 1, telemetryConfig: { transport } });
    const result = await agent.run();

    const decisionStarted = eventsOf(transport, 'step.started').find(
      (event) => (event.payload as { name: string }).name === 'execution_strategy',
    );
    assert.ok(decisionStarted);
    const metadata = (decisionStarted.payload as { metadata: Record<string, unknown> }).metadata;
    assert.equal(metadata.decisionType, 'execution_strategy');
    assert.equal(metadata.mode, result.strategy.mode);
    assert.equal(metadata.evaluatorVersion, result.strategy.evaluatorVersion);
    assert.ok(String(metadata.evaluatorVersion).startsWith('strategy-evaluator@'));
    assert.ok(typeof metadata.awarenessContext === 'object' && metadata.awarenessContext !== null);
  });
});

void describe('MockAgent — follows the evaluator verdict, not just reports it', () => {
  void it('NEGATIVE — a single default task is sequential by construction (fewer than two runnable tasks)', async () => {
    const transport = new RecordingTransport();
    const agent = new MockAgent({ seed: 1, telemetryConfig: { transport } });
    const result = await agent.run();

    assert.equal(result.strategy.mode, 'sequential');
    assert.equal(result.strategy.eligible, false);
  });

  void it('two independent tasks under enough concurrency: both Execute-phase tasks start before either completes', async () => {
    const transport = new RecordingTransport();
    const scheduler = new FakeScheduler();
    const agent = new MockAgent({
      seed: 1,
      tasks: [{ name: 'a' }, { name: 'b' }],
      delayMs: 10,
      scheduler,
      // maxBatchSize: 1 — a mid-run checkpoint assertion below reads `transport.allEvents`
      // before `run()` has finished; the client otherwise buffers events and only delivers
      // them on its own batching cadence (`playground/index.ts`'s `PLAYGROUND_TELEMETRY_
      // DEFAULTS`, or the SDK's own interval/size defaults), which `run()`'s single
      // `flush()` at the very end would make this checkpoint see nothing until too late.
      telemetryConfig: { transport, maxBatchSize: 1 },
    });

    const runPromise = agent.run();

    await scheduler.advance(10); // settles Plan's invoke(); Execute begins
    assert.deepEqual(namesOf(transport, 'step.started').slice(-3), [
      'execution_strategy',
      'a',
      'b',
    ]);
    // Plan and the (immediate) execution_strategy decision are complete; neither task is —
    // "both start before either completes" is exactly what parallel mode promises.
    assert.deepEqual(completedNames(transport), ['plan', 'execution_strategy']);

    await scheduler.advance(10); // settles both task invokes (and Execute) at once
    assert.deepEqual(completedNames(transport).slice(2).sort(), ['a', 'b', 'execute']);

    await scheduler.advance(10); // settles Validate

    const result = await runPromise;
    assert.equal(result.strategy.mode, 'parallel');
    assert.equal(result.strategy.eligible, true);
    assert.equal(result.status, 'COMPLETED');
    assert.deepEqual(result.tasks.map((task) => task.name).sort(), ['a', 'b']);
  });

  void it('two tasks under insufficient availableConcurrency run strictly sequentially: "b" is not started until "a" completes', async () => {
    const transport = new RecordingTransport();
    const scheduler = new FakeScheduler();
    const agent = new MockAgent({
      seed: 1,
      tasks: [{ name: 'a' }, { name: 'b' }],
      availableConcurrency: 1,
      delayMs: 10,
      scheduler,
      telemetryConfig: { transport, maxBatchSize: 1 }, // see the sibling parallel test's note
    });

    const runPromise = agent.run();

    await scheduler.advance(10); // settles Plan; Execute begins, task "a" starts
    assert.deepEqual(namesOf(transport, 'step.started').slice(-2), ['execution_strategy', 'a']);

    await scheduler.advance(10); // settles "a"; "b" starts only now — never before "a" completed
    assert.deepEqual(namesOf(transport, 'step.started').slice(-1), ['b']);
    assert.deepEqual(completedNames(transport), ['plan', 'execution_strategy', 'a']);

    await scheduler.advance(10); // settles "b"
    await scheduler.advance(10); // settles Validate

    const result = await runPromise;
    assert.equal(result.strategy.mode, 'sequential');
    assert.ok(
      result.strategy.blockers.some(
        (blocker) => blocker.code === 'insufficient-available-concurrency',
      ),
    );
    assert.equal(result.status, 'COMPLETED');
  });

  void it('an explicit awarenessContext override is used verbatim instead of the derived default', async () => {
    const transport = new RecordingTransport();
    const agent = new MockAgent({
      seed: 1,
      tasks: [{ name: 'a' }, { name: 'b' }],
      telemetryConfig: { transport },
      awarenessContext: {
        schemaVersion: 1,
        topology: {
          taskCount: 2,
          runnableTaskCount: 2,
          dependencyCount: 1,
          unresolvedDependencyCount: 1,
          dependenciesKnown: true,
        },
        resources: {
          claimedResourceCount: 0,
          conflictingResourceCount: 0,
          conflictsChecked: true,
          sharedMutableState: false,
        },
        readiness: {
          requirementsComplete: true,
          contractsStable: true,
          validationAvailable: true,
          independentlyValidatable: true,
          independentlyReversible: true,
        },
        limits: { requestedConcurrency: 2, availableConcurrency: 4 },
        risk: { level: 'low', reasons: [] },
      },
    });

    const result = await agent.run();

    assert.equal(result.strategy.mode, 'sequential');
    assert.ok(
      result.strategy.blockers.some((blocker) => blocker.code === 'unresolved-dependencies'),
    );
  });
});

void describe('MockAgent — failure short-circuits later phases', () => {
  void it('a Plan failure marks the run FAILED and never starts Execute or Validate', async () => {
    const transport = new RecordingTransport();
    const agent = new MockAgent({
      seed: 1,
      alwaysFailSteps: ['plan'],
      telemetryConfig: { transport },
    });

    const result = await agent.run();

    assert.equal(result.status, 'FAILED');
    assert.deepEqual(namesOf(transport, 'step.started'), ['plan']);
    assert.deepEqual(result.tasks, []);
    const runCompleted = eventsOf(transport, 'run.completed')[0];
    assert.equal((runCompleted?.payload as { status: string }).status, 'FAILED');
  });

  void it('a task failure marks Execute and the run FAILED and never starts Validate', async () => {
    const transport = new RecordingTransport();
    const agent = new MockAgent({
      seed: 1,
      tasks: [{ name: 'a' }, { name: 'b' }],
      alwaysFailSteps: ['b'],
      telemetryConfig: { transport },
    });

    const result = await agent.run();

    assert.equal(result.status, 'FAILED');
    assert.equal(namesOf(transport, 'step.started').includes('validate'), false);
    const taskB = result.tasks.find((task) => task.name === 'b');
    const taskA = result.tasks.find((task) => task.name === 'a');
    assert.equal(taskA?.status, 'COMPLETED');
    assert.equal(taskB?.status, 'FAILED');
    assert.ok(taskB?.error?.includes('simulated failure'));
  });
});

void describe('MockAgent — determinism (same seed → byte-identical telemetry)', () => {
  async function runScenario(seed: number): Promise<RecordingTransport> {
    const transport = new RecordingTransport();
    const agent = new MockAgent({ seed, telemetryConfig: { transport } });
    await agent.run();
    return transport;
  }

  void it('NEGATIVE — a different seed produces different event ids and timestamps', async () => {
    const first = await runScenario(11);
    const second = await runScenario(22);

    assert.notDeepEqual(
      first.allEvents.map((event) => event.eventId),
      second.allEvents.map((event) => event.eventId),
    );
    assert.notDeepEqual(
      first.allEvents.map((event) => event.occurredAt),
      second.allEvents.map((event) => event.occurredAt),
    );
  });

  void it('emits byte-identical events across two independently constructed agents with the same seed', async () => {
    const first = await runScenario(42);
    const second = await runScenario(42);

    assert.ok(first.allEvents.length > 0);
    assert.deepEqual(second.allEvents, first.allEvents);
    assert.equal(JSON.stringify(second.allEvents), JSON.stringify(first.allEvents));
  });
});
