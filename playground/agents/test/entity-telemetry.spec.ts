/**
 * Seam: `MockAgent.run()` (the Playground's public entry) observed through the INJECTED
 * `TelemetryTransport` — the envelopes the reference consumer actually put on the wire.
 * Same seam `mock-agent.spec.ts` uses; this file asks the two questions that file could not,
 * because the events did not exist: does a real Playground run say WHICH MODELS WERE CALLED,
 * and WHERE FAILURES OCCURRED (`MVP_PLAN_V3.md:1802-1805`)?
 *
 * The oracle for the payload values is `MockProvider` itself, invoked directly with the same
 * seed at a different seam (`probeProvider` below). `MockAgent` and this test therefore do
 * not agree by construction: if the agent were to emit a plausible constant instead of the
 * measurement the call produced, the probe would disagree with it.
 *
 * Runner: Node's built-in `node:test`/`node:assert/strict`, the convention every other
 * `playground/**` spec uses.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MockProvider, MockProviderFailure, type MockProviderResponse } from '../../providers';
import { MockAgent, type MockAgentConfig } from '../index';
import { FakeScheduler } from './support/fake-scheduler';
import { RecordingTransport, type RecordedEnvelope } from './support/recording-transport';

/** A range, not a fixed value: a per-call simulated latency that VARIES is what makes
 *  "carries the real latency" falsifiable — a hardcoded constant in the emitter would still
 *  match a fixed delay. Sampled deterministically per call from the seed. */
const DELAY = { min: 3, max: 97 } as const;

/** Every timer this scenario can arm is bounded by `DELAY.max`, so one advance past it
 *  settles whatever is currently pending. */
const ADVANCE = DELAY.max + 1;

/** §13's token counts have to be a function of the text a call handled. The 4:1 rule of
 *  thumb is restated here rather than imported from `mock-provider.ts`, so the expectation
 *  is sourced independently of the code that produced it (TEST-4). */
const CHARS_PER_TOKEN = 4;

/** `MockProviderFailure`'s own message template, restated (TEST-4) — NOT read off a
 *  `MockProviderFailure` instance, real or synthesized. `probeProvider` below constructs a
 *  genuine rejection from the same production `MockProviderFailure` class production also
 *  raises, so comparing against `failure.message` would make the assertion travel with a
 *  mutation to the template in `mock-provider.ts` instead of catching it — both sides would
 *  still agree, having both changed the same way. This literal is the one thing in this
 *  file that does not move if that template changes. */
function expectedFailureMessage(step: string, callIndex: number): string {
  return `MockProvider: simulated failure at step "${step}" (call ${callIndex})`;
}

type ModelCallPayload = {
  stepId: string;
  provider: string;
  model: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  status: string;
};

type ErrorPayload = { stepId: string; type: string; message: string; metadata?: unknown };

function eventsOf(transport: RecordingTransport, type: string): RecordedEnvelope[] {
  return transport.allEvents.filter((event) => event.type === type);
}

/** `stepId` → the step's NAME, so a model call can be attributed to the phase that made it.
 *  Only `step.started` carries the name; everything else carries the id. */
function stepNames(transport: RecordingTransport): Map<string, string> {
  const names = new Map<string, string>();
  for (const event of eventsOf(transport, 'step.started')) {
    names.set(event.entityId, (event.payload as { name: string }).name);
  }
  return names;
}

/** One full `MockAgent` run under a scheduler this test drives — no real waiting. */
async function runAgent(
  config: Omit<MockAgentConfig, 'delayMs' | 'scheduler' | 'telemetryConfig'>,
): Promise<RecordingTransport> {
  const transport = new RecordingTransport();
  const scheduler = new FakeScheduler();
  const agent = new MockAgent({
    ...config,
    delayMs: DELAY,
    scheduler,
    telemetryConfig: { transport },
  });

  const pending = agent.run();
  // Plan, then the Execute tasks, then Validate — one advance each, plus slack for a run
  // that short-circuits earlier.
  for (let phase = 0; phase < 4; phase += 1) await scheduler.advance(ADVANCE);
  await pending;

  return transport;
}

/**
 * The independent oracle: what `MockProvider` really produces for this seed and step,
 * observed at the provider's own return value rather than through the agent. `MockAgent`
 * hands the raw `seed` to the provider domain unchanged (its module doc), so the same seed
 * here reproduces the same call.
 *
 * `alwaysFailSteps` must mirror whatever the scenario under test passed to `MockAgent` —
 * the probe has to select the SAME outcome (success or rejection) the agent's own provider
 * selected, or it is not observing the same call. Passing `[]` when the scenario really
 * fails `step` makes the probe agree with itself instead of with the agent: it would never
 * enter `MockProvider.invoke()`'s reject branch, so `.catch` below and the failure caller
 * gets back would both be reachable in name only.
 */
async function probeProvider(
  seed: number,
  step: string,
  alwaysFailSteps: readonly string[] = [],
): Promise<MockProviderResponse | MockProviderFailure> {
  const scheduler = new FakeScheduler();
  const provider = new MockProvider({ seed, delayMs: DELAY, scheduler, alwaysFailSteps });
  const pending = provider.invoke({ step }).catch((error: unknown) => {
    if (error instanceof MockProviderFailure) return error;
    throw error;
  });
  await scheduler.advance(ADVANCE);
  return pending;
}

void describe('MockAgent — NEGATIVE: a clean run reports no failures', () => {
  void it('emits no error.recorded at all when nothing failed', async () => {
    // Written first (CLAUDE.md: negative fixtures before the positive path). A producer that
    // emitted an Error per step regardless of outcome would satisfy every positive assertion
    // below and make "where failures occurred" answer "everywhere".
    const transport = await runAgent({ seed: 7 });

    assert.equal(eventsOf(transport, 'error.recorded').length, 0);
    assert.equal(
      JSON.stringify(transport.allEvents).includes('error.recorded'),
      false,
      'no error.recorded reached the wire on a run with failureRate 0',
    );
  });

  void it('emits exactly one model_call.recorded per provider call — Plan, the task, Validate', async () => {
    const transport = await runAgent({ seed: 7 });
    const names = stepNames(transport);

    const owners = eventsOf(transport, 'model_call.recorded').map((event) =>
      names.get((event.payload as ModelCallPayload).stepId),
    );
    assert.deepEqual(owners, ['plan', 'default', 'validate']);
    // The `execution_strategy` decision Step makes no provider call and must not carry one.
    assert.equal(owners.includes('execution_strategy'), false);
  });
});

void describe('MockAgent — which models were called', () => {
  void it('carries the provider, model, latency and token counts the invocation actually produced', async () => {
    const seed = 7;
    const transport = await runAgent({ seed });
    const names = stepNames(transport);

    const byStep = new Map<string, ModelCallPayload>();
    for (const event of eventsOf(transport, 'model_call.recorded')) {
      const payload = event.payload as ModelCallPayload;
      byStep.set(names.get(payload.stepId) ?? '?', payload);
    }

    for (const step of ['plan', 'default', 'validate']) {
      const expected = await probeProvider(seed, step);
      assert.ok(!(expected instanceof MockProviderFailure), `${step} should not fail at seed 7`);
      const actual = byStep.get(step);
      assert.ok(actual, `no model_call.recorded for step "${step}"`);
      assert.equal(actual.provider, expected.provider);
      // Pinned to the literal, not `expected.model`: `expected.model` traces back through
      // `probeProvider` -> `MockProvider` -> `MOCK_PROVIDER_MODEL`, the same constant the
      // emitter would restate — so comparing the two would agree even if the emitter hardcoded
      // 'mock-model-v1' instead of reading `response.model` off the call.
      assert.equal(actual.model, 'mock-model-v1');
      assert.equal(actual.latencyMs, expected.latencyMs);
      assert.equal(actual.status, 'success');
      // Token counts are checked against the TEXT, not against the provider's own counter:
      // `expected.inputTokens` is the same computation the emitter's value came from, so
      // comparing the two would agree even if `countTokens` returned a constant (a mutation
      // that survived exactly that assertion). `detail` and the request string are the
      // content the call actually handled; §13's counts must be a function of it.
      assert.equal(actual.inputTokens, Math.ceil(`${step}|0`.length / CHARS_PER_TOKEN));
      assert.equal(actual.outputTokens, Math.ceil(expected.detail.length / CHARS_PER_TOKEN));
    }
  });

  void it('reports token counts that vary with the call, not one constant repeated', async () => {
    const transport = await runAgent({ seed: 7 });
    const calls = eventsOf(transport, 'model_call.recorded').map(
      (event) => event.payload as ModelCallPayload,
    );

    assert.equal(calls.length, 3);
    assert.ok(
      new Set(calls.map((call) => call.inputTokens)).size > 1,
      `all three inputTokens were identical: ${JSON.stringify(calls.map((call) => call.inputTokens))}`,
    );
    assert.ok(
      new Set(calls.map((call) => call.outputTokens)).size > 1,
      `all three outputTokens were identical: ${JSON.stringify(calls.map((call) => call.outputTokens))}`,
    );
  });

  void it('reports a latency that varies per call, not one constant repeated', async () => {
    // The falsification for the test above: if the emitter shipped a hardcoded latency the
    // per-step probe would still have to match it, so this is what separates "carries a
    // measurement" from "carries a plausible number".
    const transport = await runAgent({ seed: 7 });
    const latencies = eventsOf(transport, 'model_call.recorded').map(
      (event) => (event.payload as ModelCallPayload).latencyMs,
    );

    assert.equal(latencies.length, 3);
    assert.ok(
      new Set(latencies).size > 1,
      `all three latencies were identical: ${JSON.stringify(latencies)}`,
    );
    for (const latency of latencies) {
      assert.ok(latency >= DELAY.min && latency <= DELAY.max, `latency ${latency} out of range`);
    }
  });
});

void describe('MockAgent — where failures occurred', () => {
  void it('emits error.recorded on the real MockProviderFailure path, naming the step that failed', async () => {
    const seed = 11;
    const transport = await runAgent({
      seed,
      tasks: [{ name: 'alpha' }, { name: 'beta' }],
      alwaysFailSteps: ['beta'],
    });
    const names = stepNames(transport);

    const errors = eventsOf(transport, 'error.recorded');
    assert.equal(errors.length, 1);
    const payload = errors[0]?.payload as ErrorPayload;
    assert.equal(names.get(payload.stepId), 'beta');
    assert.equal(payload.type, 'MockProviderFailure');
    // `expectedFailureMessage`, not a real `MockProviderFailure` instance's own `.message`:
    // the message must be checked against a value independent of the template that instance
    // was built from (TEST-4), or a mutation to that template in `mock-provider.ts` would
    // move both sides of the comparison together and never be caught.
    assert.equal(payload.message, expectedFailureMessage('beta', 0));
    assert.deepEqual(payload.metadata, { step: 'beta', callIndex: 0 });
    // The run itself failed, and the successful sibling produced no Error of its own.
    assert.equal(eventsOf(transport, 'run.completed').length, 1);
  });

  void it('still reports the failed call as a model call, with status failure and no outputTokens', async () => {
    // "Which models were called" includes the ones that failed — a ModelCall that vanished
    // on rejection would make a failing provider look like a provider nobody called.
    const transport = await runAgent({
      seed: 11,
      tasks: [{ name: 'alpha' }, { name: 'beta' }],
      alwaysFailSteps: ['beta'],
    });
    const names = stepNames(transport);

    const failed = eventsOf(transport, 'model_call.recorded')
      .map((event) => event.payload as ModelCallPayload)
      .find((payload) => names.get(payload.stepId) === 'beta');

    assert.ok(failed, 'the failed step emitted no model_call.recorded');
    assert.equal(failed.status, 'failure');
    assert.equal(failed.provider, 'mock');
    assert.ok(failed.latencyMs >= DELAY.min, 'a failed call still waited its simulated latency');
    assert.ok(typeof failed.inputTokens === 'number' && failed.inputTokens > 0);
    // Absent, not zero: a call that rejected produced no output, which is not the same
    // statement as producing an empty one.
    assert.equal('outputTokens' in failed, false);
  });
});

void describe('MockAgent — §17 determinism survives the new events', () => {
  void it('produces byte-identical telemetry for the same seed, the new event types included', async () => {
    const config = {
      seed: 11,
      tasks: [{ name: 'alpha' }, { name: 'beta' }],
      alwaysFailSteps: ['beta'],
    } as const;

    const first = await runAgent(config);
    const second = await runAgent(config);

    // Guard against a vacuous pass: two runs that emitted neither new type would also be
    // byte-identical.
    assert.ok(eventsOf(first, 'model_call.recorded').length >= 3);
    assert.equal(eventsOf(first, 'error.recorded').length, 1);
    assert.deepEqual(
      JSON.parse(JSON.stringify(second.allEvents)),
      JSON.parse(JSON.stringify(first.allEvents)),
    );
  });

  void it('nothing emitted reads a wall clock — a different seed changes the latencies', async () => {
    const a = await runAgent({ seed: 11 });
    const b = await runAgent({ seed: 12 });

    const latencies = (transport: RecordingTransport): number[] =>
      eventsOf(transport, 'model_call.recorded').map(
        (event) => (event.payload as ModelCallPayload).latencyMs,
      );

    assert.notDeepEqual(latencies(a), latencies(b));
    // …and the SAME seed reproduces them exactly, which a `Date.now()` reading could not.
    assert.deepEqual(latencies(await runAgent({ seed: 11 })), latencies(a));
  });
});
