/**
 * `deriveScenarioSeed` (`../scenario-seed.ts`) in isolation — the pure function F1's fix
 * (`.artifacts/evidence/3/phase-gate/repair-1/architect-f1-decision.md` §A) is built on, kept
 * separate from `mock-agent.spec.ts`'s runId-level table (AC-6) so a purity/derivation
 * regression is diagnosable without running a full `MockAgent.run()`.
 *
 * Seams under test: purity (AC-7), key-order invariance of `metadata`/`awarenessContext`
 * (AC-7), a circular config failing loudly instead of silently falling back to the raw seed
 * (AC-8), and that the denylist actually excludes `scheduler`/`telemetryConfig` (part of "the
 * class is dead, not just the two exhibits", AC-6's own framing).
 *
 * Runner: Node's built-in `node:test`/`node:assert/strict`, matching every other
 * `playground/**` spec.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MockAgentConfig } from '../types';
import { deriveScenarioSeed, ScenarioSeedError } from '../scenario-seed';

const BASE: MockAgentConfig = { seed: 1 };

void describe('deriveScenarioSeed — purity', () => {
  void it('is deterministic: the same config derives the same seed every call', () => {
    const config: MockAgentConfig = { seed: 7, workflowName: 'w', tasks: [{ name: 'a' }] };
    assert.equal(deriveScenarioSeed(config), deriveScenarioSeed(config));
    assert.equal(deriveScenarioSeed(config), deriveScenarioSeed({ ...config }));
  });

  void it('NEGATIVE — reads nothing from process.env: mutating TZ/LANG does not change the result', () => {
    const config: MockAgentConfig = {
      seed: 20260827,
      workflowName: 'mock-agent-workflow',
      contextSeed: 555555,
    };
    const before = deriveScenarioSeed(config);

    const savedTz = process.env['TZ'];
    const savedLang = process.env['LANG'];
    try {
      process.env['TZ'] = 'Asia/Tokyo';
      process.env['LANG'] = 'de_DE.UTF-8';
      assert.equal(deriveScenarioSeed(config), before);
    } finally {
      if (savedTz === undefined) delete process.env['TZ'];
      else process.env['TZ'] = savedTz;
      if (savedLang === undefined) delete process.env['LANG'];
      else process.env['LANG'] = savedLang;
    }
  });

  void it('key-insertion order of metadata does not change the result', () => {
    const a: MockAgentConfig = { seed: 1, metadata: { alpha: 1, beta: 2, gamma: 3 } };
    const b: MockAgentConfig = { seed: 1, metadata: { gamma: 3, alpha: 1, beta: 2 } };
    assert.equal(deriveScenarioSeed(a), deriveScenarioSeed(b));
  });

  void it('key-insertion order of awarenessContext does not change the result', () => {
    const context = {
      schemaVersion: 1 as const,
      topology: {
        taskCount: 2,
        runnableTaskCount: 2,
        dependencyCount: 0,
        unresolvedDependencyCount: 0,
        dependenciesKnown: true as const,
      },
      resources: {
        claimedResourceCount: 0,
        conflictingResourceCount: 0,
        conflictsChecked: true as const,
        sharedMutableState: false as const,
      },
      readiness: {
        requirementsComplete: true as const,
        contractsStable: true as const,
        validationAvailable: true as const,
        independentlyValidatable: true as const,
        independentlyReversible: true as const,
      },
      limits: { requestedConcurrency: 2, availableConcurrency: 4 },
      risk: { level: 'low' as const, reasons: [] },
    };
    // Same fields, reassembled in a different insertion order via a fresh object literal.
    const reordered = {
      risk: context.risk,
      limits: context.limits,
      readiness: context.readiness,
      resources: context.resources,
      topology: context.topology,
      schemaVersion: context.schemaVersion,
    };
    assert.equal(
      deriveScenarioSeed({ seed: 1, awarenessContext: context }),
      deriveScenarioSeed({ seed: 1, awarenessContext: reordered }),
    );
  });
});

void describe('deriveScenarioSeed — the negative control (different seed -> different derived seed)', () => {
  void it('NEGATIVE — same scenario, different seed: derived seeds differ', () => {
    assert.notEqual(
      deriveScenarioSeed({ ...BASE, seed: 1 }),
      deriveScenarioSeed({ ...BASE, seed: 2 }),
    );
  });
});

void describe('deriveScenarioSeed — the denylist', () => {
  void it('NEGATIVE — scheduler alone does not change the derived seed', () => {
    const scheduler = { schedule: () => () => undefined };
    assert.equal(deriveScenarioSeed(BASE), deriveScenarioSeed({ ...BASE, scheduler }));
  });

  void it('NEGATIVE — telemetryConfig alone does not change the derived seed', () => {
    assert.equal(
      deriveScenarioSeed(BASE),
      deriveScenarioSeed({ ...BASE, telemetryConfig: { maxRetries: 0, endpoint: 'x' } }),
    );
  });
});

void describe('deriveScenarioSeed — fails loudly instead of falling back to the raw seed', () => {
  void it('a circular metadata value throws ScenarioSeedError', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    assert.throws(() => deriveScenarioSeed({ seed: 1, metadata: circular }), ScenarioSeedError);
  });

  void it('a circular awarenessContext value (reached through a different path) throws', () => {
    const circular: Record<string, unknown> = { a: {} };
    (circular['a'] as Record<string, unknown>)['b'] = circular;
    assert.throws(() => deriveScenarioSeed({ seed: 1, metadata: circular }), ScenarioSeedError);
  });

  void it('NEGATIVE — the same object reachable twice through two different paths (not a cycle) does not throw', () => {
    const shared = { x: 1 };
    assert.doesNotThrow(() =>
      deriveScenarioSeed({ seed: 1, metadata: { first: shared, second: shared } }),
    );
  });
});
