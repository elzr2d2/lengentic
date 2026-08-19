/**
 * Workflow scenarios for the lane control plane.
 *
 * These are dry-run fixtures on purpose. Every scenario below is a claim about what the
 * workflow *decides*, and a decision can be exercised without dispatching an agent, creating
 * a worktree, or writing a line of product code. `CLAUDE.md`: never ask an agent to verify
 * what a script can verify — that applies to the dispatch rules themselves before it applies
 * to anything they dispatch.
 *
 * Scenario 1 uses fixtures rather than the live graph because no real batch is currently
 * eligible: everything in Phase 2 is downstream of `p2.shared-schema`, which is not built.
 * Scenario 15 runs the same evaluator against the live graph — deriving the batch from
 * `nextWave()` rather than a hardcoded id pair — so the approved case and the
 * real-repository case are both covered, and neither is asserted by pretending the
 * repository is in a state it is not. It is deliberately reason-agnostic: it does not pin
 * which requirement fails or assume the mode is `sequential`, because the live wave's
 * composition changes as packets land and its verdict changes with it. What it always
 * checks: mode is `sequential` iff at least one hard requirement failed, and every blocker
 * traces to a failed requirement.
 *
 *   pnpm check:lanes      (or)     pnpm lanes selftest
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  checkChangedFiles,
  checkOwnership,
  dependencyOrder,
  dependents,
  evaluate,
  integrationPlan,
  knownPhases,
  matchPath,
  nextWave,
  patternsOverlap,
  policy,
  repoState,
  unitsFor,
  validateHandoff,
  waveOutcome,
  type Decision,
  type Policy,
  type RepoState,
  type Unit,
} from '../lanes.ts';
import { loadActivation, resolveRoles, verificationBlock, type Resolved } from '../oracle.ts';
import {
  colorsEnabled,
  createLogger,
  redact,
  REDACTED,
  summaryDisagreements,
  type EventInput,
  type LogEvent,
  type Summary,
} from '../lib/log.ts';

// ── harness ───────────────────────────────────────────────────────────────────────────

interface Result {
  n: number;
  name: string;
  pass: boolean;
  detail: string;
}

const results: Result[] = [];

function scenario(n: number, name: string, fn: () => string | null): void {
  let detail: string | null;
  try {
    detail = fn();
  } catch (e: unknown) {
    detail = `threw: ${e instanceof Error ? e.message : String(e)}`;
  }
  results.push({ n, name, pass: detail === null, detail: detail ?? 'ok' });
}

async function scenarioAsync(
  n: number,
  name: string,
  fn: () => Promise<string | null>,
): Promise<void> {
  let detail: string | null;
  try {
    detail = await fn();
  } catch (e: unknown) {
    detail = `threw: ${e instanceof Error ? e.message : String(e)}`;
  }
  results.push({ n, name, pass: detail === null, detail: detail ?? 'ok' });
}

function expect(cond: boolean, message: string): string | null {
  return cond ? null : message;
}

// ── fixtures ──────────────────────────────────────────────────────────────────────────

const FIXTURE_POLICY: Policy = {
  maxConcurrency: 2,
  minUnits: 2,
  sharedWriteSurfaces: ['pnpm-lock.yaml', 'platform/database/prisma/schema.prisma'],
  serialiseIfTouches: ['platform/shared/schema/**'],
  alwaysForbidden: ['.claude/**', 'MVP_PLAN_V3.md'],
};

const CLEAN_REPO: RepoState = {
  isGitRepo: true,
  operationInProgress: null,
  conflicted: [],
  dirty: [],
  head: 'fixture0',
};

function unit(over: Partial<Unit> & { task_id: string }): Unit {
  return {
    title: `fixture ${over.task_id}`,
    lane: 'fixture',
    phase: 9,
    owner: 'builder',
    risk: 'low',
    changeClass: 'feature',
    depends_on: [],
    acceptance_criteria: ['a documented criterion'],
    validation_commands: ['pnpm test'],
    allowed_paths: [`fixture/${over.task_id}/**`],
    forbidden_paths: FIXTURE_POLICY.alwaysForbidden,
    unresolved_deps: [],
    in_batch_deps: [],
    unknown_deps: [],
    open_decisions: [],
    has_packet_source: true,
    ...over,
  };
}

function decide(units: Unit[], repo: RepoState = CLEAN_REPO): Decision {
  return evaluate(units, FIXTURE_POLICY, repo);
}

const CRITERION = 'a documented criterion';

/**
 * A lane handoff that is honestly DONE: one criterion, evidence that bears on it, a test
 * command whose counts add up. Every evidence scenario below is this object with exactly one
 * thing wrong, so a scenario's failure names the rule it broke.
 */
function doneHandoff(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: 'alpha',
    status: 'DONE',
    commit: 'a1b2c3d4',
    changed_files: ['fixture/alpha/index.ts'],
    validation: {
      commands: ['pnpm test'],
      results: [{ command: 'pnpm test', exitCode: 0, passed: true }],
    },
    acceptance_criteria: { verified: [CRITERION], unverified: [] },
    evidence: [
      {
        requirement: CRITERION,
        expected: 'the packet DoD line: emits one row per decision',
        actual: '1 row',
        verification: 'pnpm test -- decision.spec.ts',
        result: 'PASS',
        artifact: '.artifacts/runs/alpha-test.log',
      },
    ],
    tests: { discovered: 4, passed: 4, failed: 0, skipped: 0 },
    assumptions: [],
    risks: [],
    failures: [],
    follow_up_required: [],
    token_or_usage_summary: 'fixture',
    artifacts: ['.artifacts/runs/alpha-test.log'],
    ...over,
  };
}

const NO_COMMIT_CHECK = { checkCommit: false };

function failedIds(d: Decision): string[] {
  return d.requirements.filter((r) => !r.pass).map((r) => r.id);
}

// ── scenarios ─────────────────────────────────────────────────────────────────────────

export async function run(): Promise<number> {
  scenario(1, 'two independent tasks with disjoint paths are approved for parallel', () => {
    const d = decide([
      unit({ task_id: 'alpha', allowed_paths: ['platform/telemetry-sdk/**'] }),
      unit({ task_id: 'beta', allowed_paths: ['platform/api/src/**'] }),
    ]);
    return (
      expect(d.eligible, `expected eligible, blockers: ${failedIds(d).join(',')}`) ??
      expect(d.mode === 'parallel', `expected parallel, got ${d.mode}`) ??
      expect(d.max_concurrency === 2, `expected concurrency 2, got ${d.max_concurrency}`)
    );
  });

  scenario(2, 'tasks that modify the same file are forced to sequential', () => {
    const d = decide([
      unit({ task_id: 'alpha', allowed_paths: ['platform/api/src/**'] }),
      unit({ task_id: 'beta', allowed_paths: ['platform/api/src/**'] }),
    ]);
    return (
      expect(d.mode === 'sequential', `expected sequential, got ${d.mode}`) ??
      expect(failedIds(d).includes('R7'), 'expected R7 (overlap) to fail') ??
      expect(failedIds(d).includes('R8'), 'expected R8 (same file) to fail') ??
      expect(d.max_concurrency === 1, `expected concurrency 1, got ${d.max_concurrency}`)
    );
  });

  scenario(3, 'tasks with an unresolved dependency are not dispatched in parallel', () => {
    const withinBatch = decide([
      unit({ task_id: 'alpha', allowed_paths: ['a/**'] }),
      unit({
        task_id: 'beta',
        allowed_paths: ['b/**'],
        depends_on: ['alpha'],
        in_batch_deps: ['alpha'],
      }),
    ]);
    const outsideBatch = decide([
      unit({
        task_id: 'alpha',
        allowed_paths: ['a/**'],
        depends_on: ['upstream'],
        unresolved_deps: ['upstream'],
      }),
      unit({ task_id: 'beta', allowed_paths: ['b/**'] }),
    ]);
    return (
      expect(withinBatch.mode === 'sequential', 'in-batch dependency should force sequential') ??
      expect(failedIds(withinBatch).includes('R5'), 'expected R5 to fail on in-batch dependency') ??
      expect(outsideBatch.mode === 'sequential', 'unfinished upstream should force sequential') ??
      expect(failedIds(outsideBatch).includes('R6'), 'expected R6 to fail on unfinished upstream')
    );
  });

  scenario(4, 'tasks with unknown validation commands are rejected', () => {
    const d = decide([
      unit({ task_id: 'alpha', allowed_paths: ['a/**'], validation_commands: [] }),
      unit({ task_id: 'beta', allowed_paths: ['b/**'] }),
    ]);
    return (
      expect(d.mode === 'sequential', `expected sequential, got ${d.mode}`) ??
      expect(failedIds(d).includes('R3'), 'expected R3 (unknown commands) to fail') ??
      expect(failedIds(d).includes('R10'), 'expected R10 (independent validation) to fail')
    );
  });

  scenario(5, 'a lane that edits a forbidden path fails its gate', () => {
    const u = unit({ task_id: 'alpha', allowed_paths: ['platform/api/src/**'] });
    const forbidden = checkOwnership(
      ['platform/api/src/app.module.ts', '.claude/agents/builder.md'],
      u.allowed_paths,
      u.forbidden_paths,
    );
    const outside = checkOwnership(
      ['platform/dashboard/src/app/page.tsx'],
      u.allowed_paths,
      u.forbidden_paths,
    );
    const artifacts = checkOwnership(
      ['.artifacts/handoffs/9-alpha-builder.json'],
      u.allowed_paths,
      u.forbidden_paths,
    );
    return (
      expect(!forbidden.ok, 'editing .claude/ should fail the gate') ??
      expect(
        forbidden.violations.length === 1 && forbidden.violations[0]?.reason === 'forbidden path',
        `expected exactly one forbidden-path violation, got ${JSON.stringify(forbidden.violations)}`,
      ) ??
      expect(!outside.ok, 'editing outside allowed_paths should fail the gate') ??
      expect(artifacts.ok, 'writing its own handoff must not fail the lane gate')
    );
  });

  await scenarioAsync(6, 'a failed lane does not become DONE', async () => {
    const u = unit({ task_id: 'alpha', allowed_paths: ['platform/api/src/**'] });
    const base = {
      task_id: 'alpha',
      commit: '',
      changed_files: [],
      validation: {
        commands: ['pnpm test'],
        results: [{ command: 'pnpm test', exitCode: 1, passed: false }],
      },
      acceptance_criteria: { verified: [], unverified: ['a documented criterion'] },
      assumptions: [],
      risks: [],
      failures: [{ command: 'pnpm test', expected: 'exit 0', actual: 'exit 1' }],
      follow_up_required: [],
      token_or_usage_summary: 'fixture',
      artifacts: ['.artifacts/runs/alpha-test.log'],
    };

    const claimedDone = await validateHandoff({ ...base, status: 'DONE' }, u, {
      checkCommit: false,
    });
    const honestFailed = await validateHandoff({ ...base, status: 'FAILED' }, u, {
      checkCommit: false,
    });
    const unevidenced = await validateHandoff({ ...base, status: 'FAILED', failures: [] }, u, {
      checkCommit: false,
    });

    return (
      expect(
        !claimedDone.ok,
        'a handoff with unverified criteria and no commit must not validate as DONE',
      ) ??
      expect(
        honestFailed.ok,
        `an evidenced FAILED handoff must validate; got ${honestFailed.errors.join('; ')}`,
      ) ??
      expect(!unevidenced.ok, 'FAILED with no reproduction must not validate')
    );
  });

  scenario(7, 'a blocked independent lane does not stop another independent lane', () => {
    const a = unit({ task_id: 'alpha', allowed_paths: ['a/**'] });
    const b = unit({ task_id: 'beta', allowed_paths: ['b/**'] });
    const d = decide([a, b]);
    const alpha = d.lanes.find((l) => l.task_id === 'alpha');
    return (
      expect(dependents(a, [a, b]).length === 0, 'alpha should have no dependents') ??
      expect(alpha?.halts_if_failed.length === 0, 'alpha failing must halt nothing') ??
      expect(
        alpha?.independent_of.includes('beta') === true,
        'beta must be reported as independent of alpha',
      )
    );
  });

  scenario(8, 'a dependent lane does not continue after its dependency fails', () => {
    const a = unit({ task_id: 'alpha', allowed_paths: ['a/**'] });
    const b = unit({ task_id: 'beta', allowed_paths: ['b/**'], depends_on: ['alpha'] });
    const c = unit({ task_id: 'gamma', allowed_paths: ['c/**'], depends_on: ['beta'] });
    const halts = dependents(a, [a, b, c]);
    const d = decide([a, b, c]);
    const alpha = d.lanes.find((l) => l.task_id === 'alpha');
    return (
      expect(
        halts.join(',') === 'beta,gamma',
        `expected transitive halt [beta,gamma], got [${halts.join(',')}]`,
      ) ?? expect(alpha?.independent_of.length === 0, 'nothing is independent of alpha here')
    );
  });

  scenario(9, 'Tester is skipped for a deterministic non-behavioral change', () => {
    const activation = loadActivation();
    const rule = activation.classes.mechanical;
    if (!rule) return 'no `mechanical` class in agent-activation.json';
    const required = resolveRoles(rule.required, activation);
    const optional = resolveRoles(rule.optional, activation);
    const adversarial = resolveRoles(['adversarial-test'], activation);
    return (
      expect(
        !required.some((r) => adversarial.includes(r)),
        `adversarial testing must not be required for a mechanical change; got ${required.join(',')}`,
      ) ??
      expect(
        !optional.some((r) => adversarial.includes(r)),
        `adversarial testing must not even be optional for a mechanical change; got ${optional.join(',')}`,
      ) ??
      expect(required.includes('builder'), 'builder must still own the edit')
    );
  });

  scenario(10, 'Tester activates when behavior or the test oracle changes', () => {
    const activation = loadActivation();
    const rule = activation.classes.behavior;
    if (!rule) return 'no `behavior` class in agent-activation.json';
    const required = resolveRoles(rule.required, activation);
    const adversarial = resolveRoles(['adversarial-test'], activation);
    const conditions = activation.activationConditions?.['adversarial-test'] ?? [];
    return (
      expect(
        adversarial.every((r) => required.includes(r)),
        `adversarial testing must be required for a behavior change; got ${required.join(',')}`,
      ) ?? expect(conditions.length > 0, 'adversarial-test must document when it fires')
    );
  });

  scenario(11, 'Watchdog and Reviewer produce distinct decisions', () => {
    const activation = loadActivation();
    const reviewer = new Set(activation.responsibilities?.reviewer ?? []);
    const watchdog = new Set(activation.responsibilities?.watchdog ?? []);
    const shared = [...reviewer].filter((r) => watchdog.has(r));
    return (
      expect(reviewer.size > 0 && watchdog.size > 0, 'both roles must declare responsibilities') ??
      expect(shared.length === 0, `reviewer and watchdog overlap on: ${shared.join(', ')}`)
    );
  });

  scenario(12, 'integration happens in dependency order', () => {
    const units = [
      unit({ task_id: 'gamma', depends_on: ['beta'] }),
      unit({ task_id: 'alpha' }),
      unit({ task_id: 'beta', depends_on: ['alpha'] }),
    ];
    const order = dependencyOrder(units);
    return expect(
      order.join(',') === 'alpha,beta,gamma',
      `expected alpha,beta,gamma — got ${order.join(',')}`,
    );
  });

  scenario(13, 'the final full validation runs only at the intended integration point', () => {
    const units = [unit({ task_id: 'alpha' }), unit({ task_id: 'beta', depends_on: ['alpha'] })];
    const steps = integrationPlan(dependencyOrder(units), units);
    const full = steps.filter((s) => s.commands.includes('pnpm gates:full'));
    const last = steps[steps.length - 1];
    return (
      expect(full.length === 1, `expected exactly one gates:full step, got ${full.length}`) ??
      expect(last?.gate === 'BATCH-FINAL', `expected BATCH-FINAL last, got ${last?.gate}`) ??
      expect(
        steps.filter((s) => s.gate === 'PRE-INTEGRATION').length === 2,
        'expected one pre-integration gate per lane',
      )
    );
  });

  scenario(14, 'sequential fallback works when parallel eligibility is false', () => {
    const units = [
      unit({ task_id: 'alpha', allowed_paths: [] }),
      unit({ task_id: 'beta', validation_commands: [] }),
    ];
    const d = decide(units);
    return (
      expect(d.mode === 'sequential', `expected sequential, got ${d.mode}`) ??
      expect(d.eligible === false, 'eligible must be false') ??
      expect(d.max_concurrency === 1, `expected concurrency 1, got ${d.max_concurrency}`) ??
      expect(d.blockers.length > 0, 'a sequential fallback must name its blockers') ??
      expect(
        d.dependency_order.length === units.length,
        'sequential fallback must still order every unit',
      ) ??
      expect(
        d.lanes.length === units.length,
        'every unit must still appear so the coordinator can run them one at a time',
      )
    );
  });

  // Extra scenarios beyond the required fourteen — these guard the pieces the required
  // scenarios depend on, and the live graph they will actually run against.

  scenario(15, 'the live graph rejects its own next wave for a stated reason', () => {
    const ids = nextWave(2);
    if (ids.length < 2) {
      // Degenerate case: fewer than R1's minimum. Don't pass vacuously — assert the
      // evaluator itself catches it, the same way it would for any undersized batch.
      const d = evaluate(unitsFor(ids), policy(), repoState());
      return expect(
        failedIds(d).includes('R1'),
        `nextWave(2) returned ${ids.length} id(s) (below the R1 minimum of 2) but R1 did not fail`,
      );
    }
    const d = evaluate(unitsFor(ids), policy(), repoState());
    const failed = failedIds(d);
    const blockerIds = d.blockers.map((b) => b.split(' ')[0] ?? '');
    return (
      // Reason-agnostic: does not pin a mode or a requirement id, because the live wave's
      // composition — and therefore its verdict — changes as packets land. Once the wave is
      // legitimately parallel this asserts parallel-with-no-failed-requirements instead.
      expect(
        (d.mode === 'sequential') === failed.length > 0,
        `mode must be sequential iff a hard requirement failed: mode=${d.mode}, failed=${failed.join(',') || 'none'}`,
      ) ??
      expect(
        blockerIds.every((id) => failed.includes(id)),
        `every blocker must trace to a failed requirement; blockers: ${d.blockers.join(' | ')}`,
      ) ??
      expect(
        d.blockers.length === failed.length,
        'every failed requirement must surface as a blocker',
      )
    );
  });

  scenario(16, 'a shared write surface serialises an otherwise clean batch', () => {
    const d = decide([
      unit({ task_id: 'alpha', allowed_paths: ['platform/database/prisma/**'] }),
      unit({ task_id: 'beta', allowed_paths: ['platform/api/src/**'] }),
    ]);
    return (
      expect(d.mode === 'sequential', 'a migration lane must serialise') ??
      expect(failedIds(d).includes('R9'), 'expected R9 (shared write surface) to fail')
    );
  });

  scenario(17, 'an uncommitted edit inside a lane surface blocks worktree isolation', () => {
    const dirty: RepoState = { ...CLEAN_REPO, dirty: ['platform/api/src/app.module.ts'] };
    const inLane = decide(
      [
        unit({ task_id: 'alpha', allowed_paths: ['platform/api/src/**'] }),
        unit({ task_id: 'beta', allowed_paths: ['platform/telemetry-sdk/**'] }),
      ],
      dirty,
    );
    const elsewhere = decide(
      [
        unit({ task_id: 'alpha', allowed_paths: ['platform/dashboard/src/**'] }),
        unit({ task_id: 'beta', allowed_paths: ['platform/telemetry-sdk/**'] }),
      ],
      dirty,
    );
    return (
      expect(
        failedIds(inLane).includes('R13'),
        'a dirty file inside a lane surface must fail R13',
      ) ??
      expect(
        !failedIds(elsewhere).includes('R13'),
        'a dirty file outside every lane surface must not block isolation',
      )
    );
  });

  scenario(18, 'path matching and overlap behave as the gate assumes', () => {
    return (
      expect(matchPath('platform/api/src/a/b.ts', 'platform/api/src/**'), '** must cross /') ??
      expect(
        !matchPath('platform/apix/src/a.ts', 'platform/api/**'),
        'prefix must respect segments',
      ) ??
      expect(!matchPath('platform/api/src/a/b.ts', 'platform/api/src/*'), '* must not cross /') ??
      expect(matchPath('.claude/agents/builder.md', '.claude/**'), 'dotted roots must match') ??
      expect(
        patternsOverlap('platform/api/src/**', 'platform/api/**'),
        'a nested pattern must be reported as overlapping its parent',
      ) ??
      expect(
        !patternsOverlap('platform/api/**', 'platform/telemetry-sdk/**'),
        'sibling packages must not be reported as overlapping',
      )
    );
  });

  scenario(19, 'a single eligible unit still runs sequentially', () => {
    const d = decide([unit({ task_id: 'alpha' })]);
    return (
      expect(d.mode === 'sequential', 'one unit is not a batch') ??
      expect(failedIds(d).includes('R1'), 'expected R1 to fail on a single unit')
    );
  });

  await scenarioAsync(20, 'the hook matcher and the CLI matcher agree', async () => {
    const libPath = new URL('../../.claude/hooks/lib/match-path.mjs', import.meta.url).href;
    const lib = (await import(libPath)) as {
      matchPath: (p: string, pattern: string) => boolean;
    };
    const cases: Array<[string, string]> = [
      ['platform/api/src/a/b.ts', 'platform/api/src/**'],
      ['platform/api/src/a.ts', 'platform/api/src/*'],
      ['platform/api/src/a/b.ts', 'platform/api/src/*'],
      ['platform/apix/src/a.ts', 'platform/api/**'],
      ['.claude/agents/builder.md', '.claude/**'],
      ['MVP_PLAN_V3.md', 'MVP_PLAN_V3.md'],
      ['docs/a/b/c.md', 'docs/**/c.md'],
      ['a.ts', '*.ts'],
      ['src/a.ts', '*.ts'],
      ['platform/database/prisma/schema.prisma', 'platform/database/prisma/**'],
    ];
    const drift = cases.filter(
      ([p, pattern]) => matchPath(p, pattern) !== lib.matchPath(p, pattern),
    );
    return expect(
      drift.length === 0,
      `matcher drift on: ${drift.map(([p, g]) => `${p} ~ ${g}`).join('; ')}`,
    );
  });

  scenario(21, 'the PreToolUse hook blocks and allows the right paths', () => {
    const lane = fileURLToPath(new URL('./fixtures/lane.json', import.meta.url));
    const hook = fileURLToPath(
      new URL('../../.claude/hooks/check-lane-ownership.mjs', import.meta.url),
    );
    const run = (path: string): number => {
      const r = spawnSync(process.execPath, [hook, '--lane', lane, '--path', path], {
        encoding: 'utf8',
      });
      return r.status ?? -1;
    };
    return (
      expect(run('platform/api/src/app.module.ts') === 0, 'an in-surface edit must be allowed') ??
      expect(
        run('.artifacts/handoffs/2-x-builder.json') === 0,
        'a lane must write its own handoff',
      ) ??
      expect(run('.claude/agents/builder.md') === 2, 'a forbidden-path edit must be blocked') ??
      expect(
        run('platform/dashboard/src/app/page.tsx') === 2,
        'an out-of-surface edit must be blocked',
      ) ??
      expect(run('../elsewhere/x.ts') === 2, 'an escape from the repository must be blocked')
    );
  });

  scenario(22, 'no lane file means the hook does not enforce anything', () => {
    const hook = fileURLToPath(
      new URL('../../.claude/hooks/check-lane-ownership.mjs', import.meta.url),
    );
    const payload = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: 'platform/dashboard/src/app/page.tsx' },
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
    });
    const r = spawnSync(process.execPath, [hook], { input: payload, encoding: 'utf8' });
    return expect(
      r.status === 0,
      `the main session is not a lane and must not be gated; exit ${r.status}, stderr: ${r.stderr}`,
    );
  });

  await scenarioAsync(23, 'a DONE lane with evidence per criterion validates', async () => {
    const u = unit({ task_id: 'alpha' });
    const v = await validateHandoff(doneHandoff(), u, NO_COMMIT_CHECK);
    return expect(v.ok, `an evidenced DONE handoff must validate; got: ${v.errors.join('; ')}`);
  });

  await scenarioAsync(
    24,
    'a verified criterion with no evidence does not become DONE',
    async () => {
      const u = unit({ task_id: 'alpha' });
      const missing = await validateHandoff(doneHandoff({ evidence: [] }), u, NO_COMMIT_CHECK);
      const mismatched = await validateHandoff(
        doneHandoff({
          evidence: [
            {
              requirement: 'some other thing entirely',
              expected: 'x',
              actual: 'x',
              verification: 'pnpm test',
              result: 'PASS',
            },
          ],
        }),
        u,
        NO_COMMIT_CHECK,
      );
      return (
        expect(!missing.ok, 'DONE with an empty evidence array must be refused') ??
        expect(
          mismatched.errors.some((e) => e.includes('has no matching evidence entry')),
          `evidence for a different requirement must not close this one; got: ${mismatched.errors.join('; ')}`,
        )
      );
    },
  );

  await scenarioAsync(25, 'FAIL and UNKNOWN evidence both keep a lane out of DONE', async () => {
    const u = unit({ task_id: 'alpha' });
    const withResult = async (result: string): Promise<string[]> => {
      const h = doneHandoff();
      const evidence = (h.evidence as Array<Record<string, unknown>>).map((e) => ({
        ...e,
        result,
      }));
      return (await validateHandoff({ ...h, evidence }, u, NO_COMMIT_CHECK)).errors;
    };
    const failed = await withResult('FAIL');
    const unknown = await withResult('UNKNOWN');
    return (
      expect(failed.length > 0, 'FAIL evidence must refuse DONE') ??
      expect(
        unknown.some((e) => e.includes('UNKNOWN')),
        `UNKNOWN evidence must refuse DONE by name; got: ${unknown.join('; ')}`,
      )
    );
  });

  await scenarioAsync(26, 'a suite that discovered nothing does not prove anything', async () => {
    const u = unit({ task_id: 'alpha' });
    const zero = await validateHandoff(
      doneHandoff({ tests: { discovered: 0, passed: 0, failed: 0, skipped: 0 } }),
      u,
      NO_COMMIT_CHECK,
    );
    const absent = await validateHandoff(doneHandoff({ tests: undefined }), u, NO_COMMIT_CHECK);
    const hiddenSkips = await validateHandoff(
      doneHandoff({ tests: { discovered: 9, passed: 4, failed: 0, skipped: 0 } }),
      u,
      NO_COMMIT_CHECK,
    );
    return (
      expect(
        zero.errors.some((e) => e.includes('zero tests were discovered')),
        `zero discovered tests must refuse DONE; got: ${zero.errors.join('; ')}`,
      ) ??
      expect(
        absent.errors.some((e) => e.includes('no `tests` counts')),
        `a test command with no counts must refuse DONE; got: ${absent.errors.join('; ')}`,
      ) ??
      expect(
        hiddenSkips.errors.some((e) => e.includes('unaccounted')),
        `counts that do not add up must be reported; got: ${hiddenSkips.errors.join('; ')}`,
      )
    );
  });

  await scenarioAsync(27, 'a green that contradicts its own run is refused', async () => {
    const u = unit({ task_id: 'alpha' });
    const falseGreen = await validateHandoff(
      doneHandoff({
        validation: {
          commands: ['pnpm test'],
          results: [{ command: 'pnpm test', exitCode: 1, passed: true }],
        },
      }),
      u,
      NO_COMMIT_CHECK,
    );
    const unclassified = await validateHandoff(
      doneHandoff({
        status: 'FAILED',
        validation: {
          commands: ['pnpm test'],
          results: [{ command: 'pnpm test', exitCode: 1, passed: false }],
        },
        failures: [],
      }),
      u,
      NO_COMMIT_CHECK,
    );
    const rerun = await validateHandoff(
      doneHandoff({
        validation: {
          commands: ['pnpm test', 'pnpm test'],
          results: [
            { command: 'pnpm test', exitCode: 1, passed: false },
            { command: 'pnpm test', exitCode: 0, passed: true },
          ],
        },
      }),
      u,
      NO_COMMIT_CHECK,
    );
    return (
      expect(
        falseGreen.errors.some((e) => e.includes('contradicts exitCode')),
        `passed=true on a non-zero exit must be caught; got: ${falseGreen.errors.join('; ')}`,
      ) ??
      expect(
        unclassified.errors.some((e) => e.includes('unclassified failure')),
        `a failing command in no failures entry must be caught; got: ${unclassified.errors.join('; ')}`,
      ) ??
      expect(
        rerun.errors.some((e) => e.includes('reruns of "pnpm test" disagree')),
        `a second green must not erase a first red; got: ${rerun.errors.join('; ')}`,
      )
    );
  });

  await scenarioAsync(
    28,
    'detail is referenced by path, and only known statuses pass',
    async () => {
      const u = unit({ task_id: 'alpha' });
      const pasted = await validateHandoff(
        doneHandoff({
          status: 'FAILED',
          failures: [{ command: 'pnpm test', expected: 'exit 0', actual: 'exit 1' }],
          artifacts: [],
        }),
        u,
        NO_COMMIT_CHECK,
      );
      const bogus = await validateHandoff(doneHandoff({ status: 'COMPLETE' }), u, NO_COMMIT_CHECK);
      return (
        expect(
          pasted.errors.some((e) => e.includes('no `artifacts` path')),
          `a failure with no artifact path must be caught; got: ${pasted.errors.join('; ')}`,
        ) ??
        expect(
          bogus.errors.some((e) => e.includes('DONE | BLOCKED | FAILED')),
          `a status outside the allowed set must be refused; got: ${bogus.errors.join('; ')}`,
        )
      );
    },
  );

  scenario(29, 'every agent points at the one shared output contract', () => {
    const dir = fileURLToPath(new URL('../../.claude/agents/', import.meta.url));
    const skill = fileURLToPath(
      new URL('../../.claude/skills/report-handoff/SKILL.md', import.meta.url),
    );
    const agents = readdirSync(dir).filter((f) => f.endsWith('.md'));
    const silent = agents.filter(
      (f) => !readFileSync(join(dir, f), 'utf8').includes('report-handoff'),
    );
    return (
      expect(existsSync(skill), 'the shared output contract must exist at one path') ??
      expect(agents.length > 0, 'no agent definitions found') ??
      expect(silent.length === 0, `agents that never reach the contract: ${silent.join(', ')}`)
    );
  });

  // ── logging ─────────────────────────────────────────────────────────────────────────
  //
  // The console is a rendering of the JSONL record, and the JSONL record is what an
  // evidence entry cites. Everything below is a way the two could disagree, or a way a log
  // could be read as proof of something it never observed.

  scenario(30, 'colour follows the destination, never the message', () => {
    const tty = colorsEnabled({}, { isTTY: true });
    const piped = colorsEnabled({}, { isTTY: false });
    const noColor = colorsEnabled({ NO_COLOR: '1' }, { isTTY: true });
    const ci = colorsEnabled({ CI: 'true' }, { isTTY: true });
    const forced = colorsEnabled({ CI: 'true', FORCE_COLOR: '1' }, { isTTY: false });

    const line = capture({ isTTY: true }).lines[0] ?? '';
    return (
      expect(tty, 'an interactive terminal gets colour') ??
      expect(!piped, 'a redirected stream must be plain text') ??
      expect(!noColor, 'NO_COLOR must win') ??
      expect(!ci, 'CI is not a TTY contract; plain text unless it opts in') ??
      expect(forced, 'FORCE_COLOR must be the opt-in') ??
      expect(
        line.includes(ESC),
        `a TTY line must carry the level colour; got ${JSON.stringify(line)}`,
      )
    );
  });

  await scenarioAsync(31, 'the JSONL artifact parses and carries no escape codes', async () => {
    const written = capture({ isTTY: true }, LOG_FILE).file;
    const lines = written.split('\n').filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const schema = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../.claude/rules/log-event.schema.json', import.meta.url)),
        'utf8',
      ),
    ) as object;
    const lib = (await import(
      new URL('../../.claude/hooks/lib/validate-schema.mjs', import.meta.url).href
    )) as { validate: (v: unknown, s: object) => string[] };
    const errors = parsed.flatMap((e) => lib.validate(e, schema));

    return (
      expect(lines.length > 0, 'the artifact must receive the events') ??
      expect(!written.includes(ESC), 'an escape code in a captured artifact is corruption') ??
      expect(errors.length === 0, `events must match their schema; got: ${errors.join('; ')}`)
    );
  });

  scenario(32, 'the default threshold hides DEBUG and keeps progression visible', () => {
    const replay = capture({ isTTY: false }, LOG_FILE);
    const shown = replay.lines.join('');
    const recorded = replay.file;
    return (
      expect(!shown.includes('internal step'), 'DEBUG must not reach the console at INFO') ??
      expect(recorded.includes('internal step'), 'the artifact keeps what the console hides') ??
      expect(shown.includes('BUILD started'), 'a phase start must stay visible') ??
      expect(shown.includes('typecheck 0 errors'), 'a gate result must stay visible') ??
      expect(shown.includes('RBAC mismatch'), 'a failure must stay visible')
    );
  });

  scenario(33, 'a log line cannot claim more than it observed', () => {
    const log = createLogger({ runId: 'r', artifact: '', stream: sink(), env: {} });
    const noEvidence = threw(() => log.pass('gates green', {} as { evidenceId: string }));
    const noExpected = threw(() =>
      log.error('it broke', {
        failure: { errorType: 'x', expected: '', actual: 'boom' },
      }),
    );
    const badStatus = threw(() =>
      log.event({ level: 'INFO', message: 'x', status: 'COMPLETE' as 'completed' }),
    );
    const badCounts = threw(() =>
      log.info('suite', { tests: { discovered: 4, passed: 1, failed: 0, skipped: 0 } }),
    );
    return (
      expect(
        noEvidence.includes('evidenceId'),
        `PASS without evidence must throw; got ${noEvidence}`,
      ) ??
      expect(
        noExpected.includes('expected'),
        `ERROR without expected must throw; got ${noExpected}`,
      ) ??
      expect(badStatus !== '', 'a status outside the allowed set must be refused') ??
      expect(
        badCounts.includes('discovered'),
        `counts that do not add up must throw; got ${badCounts}`,
      )
    );
  });

  scenario(34, 'a failure line carries what a reader can act on, and no more', () => {
    const replay = capture({ isTTY: false }, LOG_FILE);
    const failure = replay.events.find((e) => e.level === 'ERROR');
    const raw = replay.file;
    const byKey = redact({ password: 'hunter2', nested: { api_key: 'live-key' } }) as {
      password: string;
      nested: { api_key: string };
    };
    return (
      expect(failure !== undefined, 'the failure must be recorded') ??
      expect(
        byKey.password === REDACTED && byKey.nested.api_key === REDACTED,
        'a secret-shaped key is redacted at any depth',
      ) ??
      expect(
        failure?.failure?.expected === '200 for an authorised caller' &&
          failure?.failure?.actual === '403',
        'a failure event carries expected and actual',
      ) ??
      expect(
        failure?.evidenceId === 'EV-014' && (failure?.eventId ?? '').startsWith('ev_'),
        'a failure correlates to its evidence and to a stable event id',
      ) ??
      expect(
        failure?.failure?.classification === undefined,
        'a failure log must not classify its own root cause',
      ) ??
      expect(!raw.includes('hunter2') && !raw.includes('ghp_'), 'secrets must be redacted') ??
      expect(raw.includes(REDACTED), 'the redaction must be visible, not silent') ??
      expect(raw.includes('truncated'), 'a bounded field says where it was cut')
    );
  });

  scenario(35, 'one failure is written once and referenced afterwards', () => {
    const replay = capture({ isTTY: false }, LOG_FILE);
    const rendered = replay.lines.filter((l) => l.includes('RBAC mismatch')).length;
    const repeats = replay.events.filter((e) => e.duplicateOf !== undefined);
    const original = replay.events.find((e) => e.level === 'ERROR');
    return (
      expect(rendered === 1, `a repeated failure must render once; rendered ${rendered}`) ??
      expect(repeats.length === 1, `the repeat must still be recorded; got ${repeats.length}`) ??
      expect(
        repeats[0]?.duplicateOf === original?.eventId,
        'the repeat must reference the original event',
      )
    );
  });

  scenario(36, 'the summary is derived from the events, and an unknown is not a pass', () => {
    const replay = capture({ isTTY: false }, LOG_FILE);
    const summary = replay.summary;
    const honest = summaryDisagreements(replay.events, summary, summary.evidence_artifact);
    const inflated = summaryDisagreements(
      replay.events,
      { ...summary, gates_passed: summary.gates_passed + 1 },
      summary.evidence_artifact,
    );

    const clean = createLogger({ runId: 'r2', artifact: '', stream: sink(), env: {} });
    clean.info('phase done', { phase: 'p', status: 'completed' });
    const cleanVerdict = clean.summary().verdict;
    clean.info('could not settle it', { phase: 'p', status: 'unknown' });
    const withUnknown = clean.summary();

    return (
      expect(
        honest.length === 0,
        `a derived summary must match its events; got: ${honest.join('; ')}`,
      ) ??
      expect(inflated.length === 1, 'a summary that disagrees with its events must be caught') ??
      expect(summary.verdict === 'BLOCKED', 'a run with a failure is not DONE') ??
      expect(cleanVerdict === 'DONE', 'a clean run is DONE') ??
      expect(withUnknown.verdict === 'BLOCKED', 'an unknown keeps the verdict out of DONE') ??
      expect(withUnknown.unknowns === 1, 'the unknown stays visible in the summary')
    );
  });

  await scenarioAsync(37, 'a log may support a verdict and may never authorize one', async () => {
    const u = unit({ task_id: 'alpha' });
    const logOnly = await validateHandoff(
      doneHandoff({
        evidence: [
          {
            requirement: CRITERION,
            expected: 'the packet DoD line: emits one row per decision',
            actual: '1 row',
            verification: 'read back from the run log',
            result: 'PASS',
            source: 'log',
            eventIds: ['ev_3f21c084aa10'],
            artifact: '.artifacts/telemetry/events.jsonl',
          },
        ],
      }),
      u,
      NO_COMMIT_CHECK,
    );
    const uncitable = await validateHandoff(
      doneHandoff({
        evidence: [
          {
            requirement: CRITERION,
            expected: 'the packet DoD line: emits one row per decision',
            actual: '1 row',
            verification: 'pnpm test -- decision.spec.ts',
            result: 'PASS',
            source: 'test',
            eventIds: ['ev_3f21c084aa10'],
          },
        ],
      }),
      u,
      NO_COMMIT_CHECK,
    );
    const supported = await validateHandoff(
      doneHandoff({
        evidence: [
          {
            requirement: CRITERION,
            expected: 'the packet DoD line: emits one row per decision',
            actual: '1 row',
            verification: 'pnpm test -- decision.spec.ts',
            result: 'PASS',
            source: 'test',
            eventIds: ['ev_3f21c084aa10'],
            artifact: '.artifacts/telemetry/events.jsonl',
          },
        ],
      }),
      u,
      NO_COMMIT_CHECK,
    );
    return (
      expect(
        logOnly.errors.some((e) => e.includes('log alone')),
        `a PASS on a log alone must be refused; got: ${logOnly.errors.join('; ')}`,
      ) ??
      expect(
        uncitable.errors.some((e) => e.includes('no artifact path')),
        `an eventId nobody can follow must be refused; got: ${uncitable.errors.join('; ')}`,
      ) ??
      expect(
        supported.ok,
        `a log citation alongside a test must validate; got: ${supported.errors.join('; ')}`,
      )
    );
  });

  scenario(38, 'the logging policy is stated once and reachable from the roles that log', () => {
    const root = readFileSync(fileURLToPath(new URL('../../CLAUDE.md', import.meta.url)), 'utf8');
    const skill = fileURLToPath(
      new URL('../../.claude/skills/structured-logging/SKILL.md', import.meta.url),
    );
    const concision = root.split('Be extremely concise').length - 1;
    return (
      expect(existsSync(skill), 'the shared logging contract must exist at one path') ??
      expect(concision === 1, `the concision policy must be stated once; found ${concision}`) ??
      expect(root.includes('structured-logging'), 'the root must reach the logging contract') ??
      expect(
        readFileSync(
          fileURLToPath(new URL('../../.claude/skills/report-handoff/SKILL.md', import.meta.url)),
          'utf8',
        ).includes('structured-logging'),
        'the output contract must reach the logging contract rather than restate it',
      )
    );
  });

  await scenarioAsync(
    39,
    'a DONE handoff that omits a packet criterion entirely is refused',
    async () => {
      const u = unit({
        task_id: 'alpha',
        acceptance_criteria: ['criterion A', 'criterion B', 'criterion C'],
      });
      const evidenceFor = (req: string) => ({
        requirement: req,
        expected: 'x',
        actual: 'x',
        verification: 'pnpm test',
        result: 'PASS',
        artifact: '.artifacts/runs/alpha-test.log',
      });
      // Verifies two of the packet's three criteria and never mentions the third — neither
      // verified nor unverified. Schema-valid (unverified is empty) and exactly the hole
      // audit §3 item 1 named: a lane that lists fewer criteria than its packet reaching DONE.
      const partial = doneHandoff({
        acceptance_criteria: { verified: ['criterion A', 'criterion B'], unverified: [] },
        evidence: [evidenceFor('criterion A'), evidenceFor('criterion B')],
      });
      const full = doneHandoff({
        acceptance_criteria: {
          verified: ['criterion A', 'criterion B', 'criterion C'],
          unverified: [],
        },
        evidence: [
          evidenceFor('criterion A'),
          evidenceFor('criterion B'),
          evidenceFor('criterion C'),
        ],
      });
      // Lists criterion A in both buckets at once — the other way a handoff can dodge the
      // "exactly one bucket" rule.
      const doubled = doneHandoff({
        acceptance_criteria: {
          verified: ['criterion A', 'criterion B', 'criterion C'],
          unverified: ['criterion A'],
        },
        evidence: [
          evidenceFor('criterion A'),
          evidenceFor('criterion B'),
          evidenceFor('criterion C'),
        ],
      });
      const partialVerdict = await validateHandoff(partial, u, NO_COMMIT_CHECK);
      const fullVerdict = await validateHandoff(full, u, NO_COMMIT_CHECK);
      const doubledVerdict = await validateHandoff(doubled, u, NO_COMMIT_CHECK);
      return (
        expect(
          !partialVerdict.ok,
          'a DONE handoff that omits a packet criterion must not validate',
        ) ??
        expect(
          partialVerdict.errors.some((e) => e.includes('criterion C')),
          `the omitted criterion must be named; got: ${partialVerdict.errors.join('; ')}`,
        ) ??
        expect(
          fullVerdict.ok,
          `a handoff covering every packet criterion must validate; got: ${fullVerdict.errors.join('; ')}`,
        ) ??
        expect(
          !doubledVerdict.ok && doubledVerdict.errors.some((e) => e.includes('criterion A')),
          `a criterion in both buckets must be refused and named; got: ${doubledVerdict.errors.join('; ')}`,
        )
      );
    },
  );

  scenario(40, 'changed_files is checked against what the commit actually touched', () => {
    // A real, immutable commit from this repository's history: "docs(backlog): file
    // p2.prisma-run-step review findings, close stale gitignore entry", which touches exactly
    // one file. Sourced independently with `git diff-tree --no-commit-id --name-only -r
    // 2b489c2` before writing this scenario, not derived from the function under test.
    const sha = '2b489c2fd832000f7681a4bc8a7e09b9201dd897';
    const accurate = checkChangedFiles(sha, ['BACKLOG.md']);
    const omitted = checkChangedFiles(sha, []);
    const padded = checkChangedFiles(sha, ['BACKLOG.md', 'scripts/lanes.ts']);
    return (
      expect(
        accurate.length === 0,
        `an accurate claim must not be flagged; got: ${accurate.join('; ')}`,
      ) ??
      expect(
        omitted.some((e) => e.includes('BACKLOG.md')),
        `a file the commit touched but the claim omits must be named; got: ${omitted.join('; ')}`,
      ) ??
      expect(
        padded.some((e) => e.includes('scripts/lanes.ts')),
        `a file the claim adds but the commit never touched must be named; got: ${padded.join('; ')}`,
      )
    );
  });

  await scenarioAsync(
    41,
    'a finding handoff requires evidence on PASSED and a structured reason on BLOCKED',
    async () => {
      const schema = JSON.parse(
        readFileSync(
          fileURLToPath(new URL('../../.claude/rules/handoff.schema.json', import.meta.url)),
          'utf8',
        ),
      ) as object;
      const lib = (await import(
        new URL('../../.claude/hooks/lib/validate-schema.mjs', import.meta.url).href
      )) as { validate: (v: unknown, s: object) => string[] };
      const base = {
        status: 'PASSED',
        owner: 'validator',
        failure: '',
        evidence: [] as unknown[],
        affectedArea: 'scripts/lanes.ts',
        recommendedNextAction: 'merge',
        confidence: 'HIGH',
      };
      const passedNoEvidence = lib.validate(base, schema);
      const passedWithEvidence = lib.validate(
        {
          ...base,
          evidence: [{ command: 'pnpm test', location: 'x', expected: 'y', actual: 'z' }],
        },
        schema,
      );
      const blockedNoReason = lib.validate({ ...base, status: 'BLOCKED' }, schema);
      const blockedWithReason = lib.validate(
        { ...base, status: 'BLOCKED', blocker: { kind: 'path', ref: 'platform/x' } },
        schema,
      );
      return (
        expect(
          passedNoEvidence.some((e) => e.includes('evidence')),
          `PASSED with empty evidence must be refused; got: ${passedNoEvidence.join('; ')}`,
        ) ??
        expect(
          passedWithEvidence.length === 0,
          `PASSED with evidence must validate; got: ${passedWithEvidence.join('; ')}`,
        ) ??
        expect(
          blockedNoReason.some((e) => e.includes('blocker')),
          `BLOCKED with no blocker must be refused; got: ${blockedNoReason.join('; ')}`,
        ) ??
        expect(
          blockedWithReason.length === 0,
          `BLOCKED with a structured blocker must validate; got: ${blockedWithReason.join('; ')}`,
        )
      );
    },
  );

  await scenarioAsync(
    42,
    'a lane handoff claiming BLOCKED without a structured blocker is refused',
    async () => {
      const u = unit({ task_id: 'alpha' });
      const base = {
        task_id: 'alpha',
        status: 'BLOCKED',
        commit: '',
        changed_files: [],
        validation: { commands: [], results: [] },
        acceptance_criteria: { verified: [], unverified: ['a documented criterion'] },
        assumptions: [],
        risks: [],
        failures: [],
        follow_up_required: [],
        token_or_usage_summary: 'fixture',
      };
      const noBlocker = await validateHandoff(base, u, NO_COMMIT_CHECK);
      const withBlocker = await validateHandoff(
        { ...base, blocker: { kind: 'path', ref: 'docs/decisions/0006-x.md' } },
        u,
        NO_COMMIT_CHECK,
      );
      return (
        expect(
          noBlocker.errors.some((e) => e.includes('blocker')),
          `BLOCKED with no blocker must be refused; got: ${noBlocker.errors.join('; ')}`,
        ) ??
        expect(
          !withBlocker.errors.some((e) => e.includes('blocker')),
          `a structured blocker must satisfy the requirement; got: ${withBlocker.errors.join('; ')}`,
        )
      );
    },
  );

  scenario(
    43,
    'a unit or node with no usable changeClass hard-errors instead of shipping an empty agent chain',
    () => {
      const withoutClass = unit({ task_id: 'alpha', changeClass: null });
      const withClass = unit({ task_id: 'beta' });
      let laneError: string | null = null;
      try {
        decide([withoutClass, withClass]);
      } catch (e) {
        laneError = e instanceof Error ? e.message : String(e);
      }

      const node: Resolved = {
        id: 'fixture.unclassified',
        phase: 9,
        lane: 'fixture',
        title: 'fixture node with no changeClass',
        owner: 'builder',
        needs: [],
        probes: [],
        state: 'TODO',
        hits: 0,
        blockedBy: [],
        readiness: 'READY',
        depth: 0,
        wave: 1,
      };
      let oracleError: string | null = null;
      try {
        verificationBlock(node);
      } catch (e) {
        oracleError = e instanceof Error ? e.message : String(e);
      }

      return (
        expect(
          laneError !== null && laneError.includes('alpha'),
          `a batch containing an unclassified unit must hard-error naming it; got: ${laneError}`,
        ) ??
        expect(
          oracleError !== null && oracleError.includes('fixture.unclassified'),
          `a node with no changeClass must hard-error naming it; got: ${oracleError}`,
        )
      );
    },
  );

  scenario(
    44,
    'the SubagentStop hook validates a lane handoff against the lane schema, never the finding schema',
    () => {
      const hook = fileURLToPath(
        new URL('../../.claude/hooks/validate-handoff.mjs', import.meta.url),
      );
      const lanePath = join(tmpdir(), `selftest-lane-handoff-${process.pid}.json`);
      const findingPath = join(tmpdir(), `selftest-finding-handoff-${process.pid}.json`);
      const brokenPath = join(tmpdir(), `selftest-broken-lane-handoff-${process.pid}.json`);

      const laneHandoff = {
        task_id: 'fixture.alpha',
        status: 'DONE',
        commit: 'abcdef1234567890',
        changed_files: ['fixture/alpha/index.ts'],
        validation: {
          commands: ['pnpm test'],
          results: [{ command: 'pnpm test', exitCode: 0, passed: true }],
        },
        acceptance_criteria: { verified: ['a documented criterion'], unverified: [] },
        assumptions: [],
        risks: [],
        failures: [],
        follow_up_required: [],
        token_or_usage_summary: 'fixture',
        evidence: [
          {
            requirement: 'a documented criterion',
            expected: 'x',
            actual: 'x',
            verification: 'pnpm test',
            result: 'PASS',
          },
        ],
      };
      const findingHandoff = {
        status: 'PASSED',
        owner: 'validator',
        failure: '',
        evidence: [{ command: 'pnpm test', location: 'x', expected: 'y', actual: 'z' }],
        affectedArea: 'scripts/lanes.ts',
        recommendedNextAction: 'merge',
        confidence: 'HIGH',
      };
      // Lane-shaped (has task_id) but DONE with no evidence — invalid under lane-handoff, and
      // if it were wrongly checked against handoff.schema.json's additionalProperties:false
      // it would also fail on every lane-only field name instead.
      const brokenLaneHandoff = {
        ...laneHandoff,
        acceptance_criteria: { verified: [], unverified: [] },
        evidence: [],
      };

      writeFileSync(lanePath, JSON.stringify(laneHandoff));
      writeFileSync(findingPath, JSON.stringify(findingHandoff));
      writeFileSync(brokenPath, JSON.stringify(brokenLaneHandoff));

      const runHook = (p: string) =>
        spawnSync(process.execPath, [hook, '--file', p], { encoding: 'utf8' });

      try {
        const laneResult = runHook(lanePath);
        const findingResult = runHook(findingPath);
        const brokenResult = runHook(brokenPath);

        return (
          expect(
            laneResult.status === 0,
            `a valid lane handoff must pass; stderr: ${laneResult.stderr}`,
          ) ??
          expect(
            findingResult.status === 0,
            `a valid finding handoff must pass; stderr: ${findingResult.stderr}`,
          ) ??
          expect(
            brokenResult.status === 2,
            `an invalid lane handoff must fail; got exit ${brokenResult.status}`,
          ) ??
          expect(
            brokenResult.stderr.includes('lane-handoff.schema.json'),
            `the error must name the lane schema, not the finding schema; got: ${brokenResult.stderr}`,
          ) ??
          expect(
            !brokenResult.stderr.includes('unexpected property'),
            `a lane-shaped handoff must never be checked against handoff.schema.json's ` +
              `additionalProperties:false; got: ${brokenResult.stderr}`,
          )
        );
      } finally {
        rmSync(lanePath, { force: true });
        rmSync(findingPath, { force: true });
        rmSync(brokenPath, { force: true });
      }
    },
  );

  scenario(45, 'review runs once per wave; only perNodeClasses keep a per-node review', () => {
    const activation = loadActivation();
    const perNodeClasses = activation.reviewCadence?.perNodeClasses ?? [];
    const reviewer = resolveRoles(['review'], activation);
    const d = decide([
      unit({ task_id: 'alpha', changeClass: 'behavior', allowed_paths: ['a/**'] }),
      unit({ task_id: 'beta', changeClass: 'contract', allowed_paths: ['b/**'] }),
    ]);
    const alpha = d.lanes.find((l) => l.task_id === 'alpha');
    const beta = d.lanes.find((l) => l.task_id === 'beta');
    return (
      expect(
        perNodeClasses.includes('contract'),
        'agent-activation.json must keep contract in perNodeClasses',
      ) ??
      expect(
        alpha?.review_cadence === 'wave',
        `a behavior lane must review per wave; got ${alpha?.review_cadence}`,
      ) ??
      expect(
        alpha !== undefined && !alpha.required_agents.some((a) => reviewer.includes(a)),
        `reviewer must be stripped from a wave-cadence chain; got ${alpha?.required_agents.join(',')}`,
      ) ??
      expect(
        beta?.review_cadence === 'per-node',
        `a contract lane must keep per-node review; got ${beta?.review_cadence}`,
      ) ??
      expect(
        beta !== undefined && beta.required_agents.some((a) => reviewer.includes(a)),
        `a contract chain must keep its reviewer; got ${beta?.required_agents.join(',')}`,
      ) ??
      expect(
        d.review_cadence.wave.includes('alpha') && d.review_cadence.per_node.includes('beta'),
        `decision-level cadence lists are wrong: ${JSON.stringify(d.review_cadence)}`,
      ) ??
      expect(
        d.review_cadence.wave_review_required,
        'a wave containing a review-requiring class must require one wave review',
      )
    );
  });

  scenario(46, 'a finished phase is PHASE_COMPLETE, an unknown phase is an error', () => {
    const bogus = waveOutcome('99');
    const absent = waveOutcome(undefined);
    const phases = knownPhases();
    const mismatch = phases.find((p) => {
      const o = waveOutcome(String(p));
      const ids = nextWave(p);
      return ids.length === 0
        ? o.kind !== 'complete'
        : o.kind !== 'wave' || o.ids.join(',') !== ids.join(',');
    });
    const complete = phases.map((p) => waveOutcome(String(p))).find((o) => o.kind === 'complete');
    return (
      expect(
        bogus.kind === 'error' && bogus.message.includes('unknown phase'),
        `phase 99 must be an error naming the phase; got ${JSON.stringify(bogus)}`,
      ) ??
      expect(absent.kind === 'error', 'a missing phase argument must be an error') ??
      expect(
        mismatch === undefined,
        `waveOutcome disagrees with nextWave for phase ${String(mismatch)}`,
      ) ??
      expect(
        complete === undefined || complete.message.startsWith('PHASE_COMPLETE'),
        'a finished phase must announce itself as PHASE_COMPLETE',
      )
    );
  });

  return report();
}

// ── logging fixtures ──────────────────────────────────────────────────────────────────

const ESC = String.fromCharCode(27);
const LOG_FILE = fileURLToPath(
  new URL('../../.artifacts/scratch/selftest-events.jsonl', import.meta.url),
);

function sink(over: { isTTY?: boolean } = {}): {
  write: (chunk: string) => void;
  isTTY?: boolean;
  lines: string[];
} {
  const lines: string[] = [];
  return { write: (chunk: string) => void lines.push(chunk), lines, ...over };
}

function threw(fn: () => unknown): string {
  try {
    fn();
    return '';
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * One scripted run, replayed by every logging scenario: a phase start, a DEBUG the console
 * must hide, a gate that passed with its evidence, a failure carrying a secret and an
 * oversized field, that same failure reported a second time, and the derived summary.
 *
 * Fixed clock and fixed run id, so the event ids are stable and a scenario asserts on a
 * value rather than on whatever the last run happened to produce.
 */
function capture(
  stream: { isTTY?: boolean },
  artifact = '',
): { lines: string[]; file: string; events: readonly LogEvent[]; summary: Summary } {
  if (artifact !== '') rmSync(artifact, { force: true });
  const out = sink(stream);
  const log = createLogger({
    runId: 'selftest',
    agent: 'builder',
    phase: 'p9.fixture',
    taskId: 'alpha',
    artifact,
    stream: out,
    env: {},
    clock: () => '2026-08-16T12:41:03.000Z',
  });

  log.info('BUILD started', { status: 'started' });
  log.debug('internal step 41 of 900', { status: 'started' });
  log.pass('typecheck 0 errors', {
    status: 'passed',
    durationMs: 15200,
    evidenceId: 'EV-013',
    tests: { discovered: 12, passed: 12, failed: 0, skipped: 0 },
  });
  const broken: EventInput = {
    level: 'ERROR',
    message: 'RBAC mismatch',
    status: 'failed',
    evidenceId: 'EV-014',
    failure: {
      errorType: 'assertion',
      expected: '200 for an authorised caller',
      actual: '403',
      // Both redaction shapes and the length bound, in the one field a real failure would
      // carry them in: the invocation.
      command: `curl -H "Authorization: Bearer ghp_0123456789abcdefghij" && psql postgres://svc:hunter2@db:5432/app -c "${'x'.repeat(2400)}"`,
      exitCode: 1,
      stdoutArtifact: '.artifacts/runs/rbac.log',
    },
  };
  log.event(broken);
  log.event(broken);
  const summary = log.finish();

  return {
    lines: out.lines,
    file: artifact === '' ? '' : readFileSync(artifact, 'utf8'),
    events: log.events(),
    summary,
  };
}

function report(): number {
  const failed = results.filter((r) => !r.pass);
  console.log('\nlane workflow scenarios\n');
  for (const r of results.sort((a, b) => a.n - b.n)) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${String(r.n).padStart(2)}  ${r.name}`);
    if (!r.pass) console.log(`              ${r.detail}`);
  }
  console.log(`\n  ${results.length - failed.length}/${results.length} passed\n`);
  return failed.length === 0 ? 0 : 1;
}

function isDirectRun(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return resolve(invoked).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
}

if (isDirectRun()) {
  run()
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      console.error(e instanceof Error ? e.stack : String(e));
      process.exit(1);
    });
}
