/**
 * The worker bootstrap brief.
 *
 * A fresh worker gets the smallest brief that makes its one task executable: which task, which
 * node, what has already been tried, which artifacts carry the unresolved evidence, and the
 * exact envelope it must write before exiting. Nothing else.
 *
 * It deliberately does NOT inline the plan, the packet or the conversation that preceded it.
 * `CLAUDE.md` ## Retrieval: reading a 24k-token plan to answer one question spends most of a
 * context window on text nobody asked for, and `.claude/agents/*` already forbids telling a
 * subagent to "read the plan". So the brief carries commands, not content — `pnpm oracle
 * packet <id>` slices the binding contract for exactly this deliverable, and `pnpm kb search`
 * finds the rest with citations. A worker that needs more context fetches it; a worker that
 * does not, does not pay for it.
 *
 * The conversation is not the source of truth. Every fact in this brief has a path or a
 * command behind it, so the tenth worker on a node is briefed exactly as well as the first.
 */

import type { FlowAction } from '../flow.ts';
import type { BlockingFailure, SupervisorState } from './state.ts';
import type { WorkerTask } from './worker.ts';

export interface BriefInputs {
  task: WorkerTask;
  node: string | null;
  segment: string | null;
  action: FlowAction;
  /** Absolute path the worker must write its outcome envelope to. */
  reportPath: string;
  workerId: string;
  /** Repair strategies already spent on this node or gate, and the bound. */
  attempt: number;
  maxAttempts: number;
  state: SupervisorState;
  failures: BlockingFailure[];
  /** Lane handoffs and session briefs bearing on this node, newest first. */
  handoffs: string[];
  /** Decision records the task is bound by, e.g. the run charter. */
  decisions: string[];
  /** The deterministic steps `pnpm flow next` printed for this action. */
  steps: string[];
}

const CONTRACT = `## Your outcome envelope — write this before you exit

Orchestration reads exactly one thing from you: a JSON file at the path below, matching
\`.claude/rules/worker-outcome.schema.json\`. Nothing you print is parsed. If this file is
missing or invalid when you exit, the supervisor records FAILED — including after a clean
exit, and including when the work actually succeeded.

Write it with the Write tool. Write it LAST, after the work and its evidence are on disk.

**Never end your turn while an agent or background task you started is still running.** Ending
the turn ends this session, and the runtime kills every child with it — their reports are lost
and no envelope exists, so the supervisor records FAILED over work that was going fine. If a
step of yours dispatches agents, wait for every one of them to report, in the same turn, and
read what they returned before you decide your outcome. "Waiting on the agents" is not a state
you can exit in: if you genuinely cannot wait, that is ROTATE with a continuation brief, never
a turn that simply ends. This has cost a real phase gate its tester and reviewer passes once
already.

    {
      "schemaVersion": 1,
      "workerId": "<workerId>",
      "task": "<task>",
      "node": "<node or omit>",
      "outcome": "DONE | REPAIR_REQUIRED | BLOCKED | ROTATE | FAILED",
      "summary": "one line, for a human",
      "commit": "<sha, when you made one>",
      "handoff": "<path to the lane handoff you filed>",
      "evidence": ["<artifact path>", "..."],
      "detail": "<short captured output; anything long goes to an evidence path>"
    }

Choosing the outcome:

- DONE — the task is finished AND its evidence is on disk. For a dispatch task that means a
  commit, a lane handoff that \`pnpm lanes handoff <file>\` accepts, and every acceptance
  criterion carrying its own expected/actual/result. Deferred, skipped and unknown are all
  unverified, and unverified is not DONE.
- REPAIR_REQUIRED — a real, diagnosable failure. Say what failed and where the captured output
  is. The supervisor redispatches repair work automatically; you are not asking permission.
- ROTATE — you are running out of context, or you have reached a clean boundary and the rest is
  a fresh worker's job. Write a continuation brief first (the \`session-handoff\` skill), cite it
  as \`handoff\`, and the next worker picks up this same task with no human involved.
- BLOCKED — a \`CLAUDE.md\` ## Plan discipline escalation trigger fired. Set \`trigger\` to its
  number, \`options\` to the materially different courses of action, and \`evidence\` to the paths
  that prove it. This is the ONLY outcome that reaches a human.
- FAILED — you could not complete and could not classify why.

## What is not an escalation

A failing test, a red lint, a broken build, an ordinary implementation bug, a mechanically
resolvable merge conflict, thin evidence you could strengthen, or a node that needs another
attempt. All of those are REPAIR_REQUIRED or ordinary work. Do not ask the human. Do not stop
to confirm. \`CLAUDE.md\` ## Plan discipline: "Shall I continue?" is not a trigger.`;

function section(title: string, lines: string[]): string {
  return lines.length === 0 ? '' : `## ${title}\n\n${lines.join('\n')}\n`;
}

/** The task line each worker task opens with — what this worker is for, in one paragraph. */
export function taskBrief(i: BriefInputs): string {
  switch (i.task) {
    case 'dispatch':
      return (
        `Implement the work packet \`${i.node ?? '?'}\` and nothing else. Start with:\n\n` +
        `    pnpm oracle packet ${i.node ?? '<id>'}\n\n` +
        'That is the whole binding contract — the deliverable, the dependencies, the allowed ' +
        'paths, the acceptance criteria and the verification commands. You do not need to read ' +
        '`MVP_PLAN_V3.md`. Anything valuable but outside the packet goes to `BACKLOG.md` ' +
        '(`update-backlog`), never into this commit.\n\n' +
        "Stay inside the packet's `allowed_paths`. Widening your own boundary is never the " +
        'answer — a BLOCKED envelope naming the path is.'
      );
    case 'repair':
      return (
        `Repair \`${i.node ?? 'the failing gate'}\`. This is attempt ${String(i.attempt)} of ` +
        `${String(i.maxAttempts)}, and an attempt is a materially different, evidence-driven ` +
        'strategy — re-running the same command is not one, and neither is the same fix applied ' +
        'more carefully.\n\n' +
        'Reproduce first, then diagnose, then fix the diagnosed cause and nothing else, then ' +
        'prove it with the narrowest command that exercises only this fix. Never weaken an ' +
        'assertion, delete a test, broaden a tolerance or add a retry to obtain green.'
      );
    case 'integrate':
      return (
        'Integrate the lanes whose handoffs are validated but whose work is not on this tree. ' +
        "Sequential, in dependency order, whatever the dispatch mode was. Re-run each lane's " +
        'own verification commands after its merge. Worktrees and branches are never deleted.'
      );
    case 'wave-gate':
      return (
        `Run the wave gate for segment ${i.segment ?? '?'}. The deterministic gates have already ` +
        'been run by the supervisor and were GREEN — your job is the part no script can do: ' +
        "dispatch the agents the printed cadence requires, over the wave's COMBINED diff, and " +
        'flush `.artifacts/backlog/pending.md` into `BACKLOG.md`. Report every finding with its ' +
        '`this-node` / `<node-id>` / `plan` tag. Do not record the gate — the supervisor does ' +
        'that, and only if the invariant holds.'
      );
    case 'phase-gate':
      return (
        `Run the phase gate for segment ${i.segment ?? '?'}. The deterministic gates have already ` +
        'been run by the supervisor and were GREEN. Your job: `validate-phase` against the ' +
        'phase Definition of Done, checkbox by checkbox, each one bound to its evidence; then ' +
        'the per-phase agents the printed cadence requires. Report a checkbox you cannot bind ' +
        'as NOT MET — a phase at exit 0 with an unbound checkbox is RED. Do not record the ' +
        'gate; the supervisor does that.'
      );
    case 'reconcile':
      return (
        'Reconcile a recovery the checkpoint claims is in flight. Re-check the named node ' +
        'against `pnpm oracle status`. If the oracle reports it DONE, or ready with the fix ' +
        "already on its lane branch, the bookkeeping is stale: record the attempt's outcome " +
        'from the evidence on disk and clear the `recovering` step. Recovery is resumed only ' +
        'for a red that reproduces NOW, never because a file says so.'
      );
  }
}

export function buildBrief(i: BriefInputs): string {
  const header = [
    '# Autopilot worker brief',
    '',
    'You are a disposable worker in a supervised autonomous run. The supervisor derives what ' +
      'happens next from the repository — probes, gate records, handoffs — never from anything ' +
      'you say. You own ONE task. When it is finished, or when you run out of room, you write ' +
      'your outcome envelope and exit; another worker continues. There is no human watching ' +
      'this session, and none will answer a question.',
    '',
    `- worker: \`${i.workerId}\``,
    `- task: \`${i.task}\``,
    `- segment / phase: \`${i.segment ?? '?'}\``,
    `- node: \`${i.node ?? '(none — this is a gate task)'}\``,
    `- attempt: ${String(i.attempt)} of ${String(i.maxAttempts)}`,
    `- supervisor run: \`${i.state.runId}\``,
    `- flow action that produced you: \`${i.action.action}\``,
    '',
  ].join('\n');

  const steps = section(
    'The deterministic steps `pnpm flow next` printed',
    i.steps.map((s) => `- \`${s}\``),
  );

  const failures = section(
    'Unresolved failure evidence — read these before you start',
    i.failures.map(
      (f) =>
        `- **${f.kind}** ${f.node ?? f.segment ?? ''} — ${f.detail}\n` +
        (f.evidence.length > 0 ? `  evidence: ${f.evidence.join(', ')}\n` : ''),
    ),
  );

  const handoffs = section(
    'Latest handoffs bearing on this task',
    i.handoffs.map((h) => `- \`${h}\``),
  );

  const decisions = section(
    'Decision records that bind you',
    i.decisions.map((d) => `- \`${d}\``),
  );

  const retrieval = [
    '## Getting context without spending your window on it',
    '',
    '`CLAUDE.md` is already loaded. For anything else:',
    '',
    '- `pnpm oracle packet <id>` — the sliced, binding contract for one packet',
    '- `pnpm kb search <words>` — ranked sections with `file:line` citations; search before read',
    '- `pnpm kb show §19` — one section verbatim',
    '- `pnpm oracle status` — what is genuinely done, probed rather than asserted',
    '',
    'Do not read `MVP_PLAN_V3.md` or `BACKLOG.md` whole. Do not go looking for the conversation ' +
      'that led here; there is not one, and the repository holds everything that mattered.',
    '',
  ].join('\n');

  return [
    header,
    `## Your task\n\n${taskBrief(i)}\n`,
    steps,
    failures,
    handoffs,
    decisions,
    retrieval,
    CONTRACT.replace('<workerId>', i.workerId)
      .replace('<task>', i.task)
      .replace('<node or omit>', i.node ?? 'omit'),
    '',
    `Envelope path: \`${i.reportPath}\``,
  ]
    .filter((s) => s !== '')
    .join('\n');
}
