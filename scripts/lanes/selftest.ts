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
 * Scenario 15 runs the same evaluator against the live graph and asserts that — so the
 * approved case and the real-repository case are both covered, and neither is asserted by
 * pretending the repository is in a state it is not.
 *
 *   pnpm check:lanes      (or)     pnpm lanes selftest
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import {
  checkOwnership,
  dependencyOrder,
  dependents,
  evaluate,
  integrationPlan,
  matchPath,
  patternsOverlap,
  policy,
  repoState,
  unitsFor,
  validateHandoff,
  type Decision,
  type Policy,
  type RepoState,
  type Unit,
} from '../lanes.ts';
import { loadActivation, resolveRoles } from '../oracle.ts';

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
    const ids = ['p2.merge-rules', 'p2.sdk-core'];
    const d = evaluate(unitsFor(ids), policy(), repoState());
    const failed = failedIds(d);
    return (
      expect(d.mode === 'sequential', `expected sequential on the live graph, got ${d.mode}`) ??
      expect(
        failed.includes('R6'),
        `expected R6 (frozen contracts) to fail while p2.shared-schema is unbuilt; failed: ${failed.join(',')}`,
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

  return report();
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
