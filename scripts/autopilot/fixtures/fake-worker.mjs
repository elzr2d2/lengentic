#!/usr/bin/env node
/**
 * A worker that is a real process but not a real Claude session.
 *
 * The supervisor's hard cases are all about process boundaries: a worker that dies mid-node,
 * one that rotates because its context ran out, one that keeps asking for repair until the
 * bound is spent, two that try to own the same node. Testing those against real sessions would
 * be slow, non-deterministic and expensive, and testing them against an in-process stub would
 * not test the thing that actually breaks — the boundary.
 *
 * So this is spawned exactly the way `claude -p` is, reads the same `AUTOPILOT_*` environment,
 * writes the same outcome envelope, and is told what to do by a plan file. `pnpm
 * check:autopilot` points `AUTOPILOT_WORKER_CMD` at it.
 *
 * Plan file (`FAKE_WORKER_PLAN`), consumed one entry per launch:
 *
 *   {
 *     "steps": { "dispatch:p9.a": ["ROTATE", "DONE"], "default": ["DONE"] },
 *     "evidenceDir": ".artifacts/evidence/fake"
 *   }
 *
 * Behaviours: DONE | ROTATE | REPAIR_REQUIRED | BLOCKED | FAILED (an envelope saying so),
 * CRASH (non-zero exit, no envelope), SILENT (exit 0, no envelope), HANG (sleep past the
 * supervisor's timeout).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const planPath = process.env.FAKE_WORKER_PLAN;
if (!planPath) {
  console.error('FAKE_WORKER_PLAN is not set');
  process.exit(3);
}

const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const counterPath = `${planPath}.counters.json`;
const counters = existsSync(counterPath) ? JSON.parse(readFileSync(counterPath, 'utf8')) : {};

const task = process.env.AUTOPILOT_TASK ?? 'dispatch';
const node = process.env.AUTOPILOT_NODE ?? '';
const workerId = process.env.AUTOPILOT_WORKER_ID ?? 'fake';
const sessionId = process.env.AUTOPILOT_SESSION_ID ?? 'fake-session';
const reportPath = process.env.AUTOPILOT_REPORT_PATH;

const key = node === '' ? task : `${task}:${node}`;
const steps = plan.steps?.[key] ?? plan.steps?.[node] ?? plan.steps?.default ?? ['DONE'];
const index = counters[key] ?? 0;
counters[key] = index + 1;
writeFileSync(counterPath, JSON.stringify(counters, null, 2), 'utf8');

const behaviour = steps[Math.min(index, steps.length - 1)];

// A launch log is how the scenarios prove a SECOND process ran on the same node, rather than
// the supervisor looping inside one.
appendFileSync(
  `${planPath}.launches.jsonl`,
  `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, task, node, workerId, sessionId, behaviour })}\n`,
  'utf8',
);

console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }));

function evidenceFile(name) {
  const dir = resolve(process.cwd(), plan.evidenceDir ?? '.artifacts/evidence/fake');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `fake worker ${workerId} for ${key}, launch ${index + 1}\n`, 'utf8');
  return `${plan.evidenceDir ?? '.artifacts/evidence/fake'}/${name}`;
}

function writeEnvelope(extra) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        workerId,
        sessionId,
        task,
        ...(node === '' ? {} : { node }),
        summary: `fake worker: ${behaviour} on ${key} (launch ${index + 1})`,
        ...extra,
      },
      null,
      2,
    ),
    'utf8',
  );
}

switch (behaviour) {
  case 'DONE': {
    // A phase-gate worker's Definition-of-Done artifact is checked mechanically by the
    // supervisor, so a fake DONE has to produce one that actually passes that check.
    const evidence = [evidenceFile(`${workerId}.md`)];
    if (task === 'phase-gate' && plan.dodPath) {
      mkdirSync(dirname(resolve(process.cwd(), plan.dodPath)), { recursive: true });
      writeFileSync(
        resolve(process.cwd(), plan.dodPath),
        plan.dodBody ?? '# Definition of Done\n\n- [x] every checkbox bound to evidence\n',
        'utf8',
      );
      evidence.push(plan.dodPath);
    }
    writeEnvelope({ outcome: 'DONE', evidence, commit: plan.commit ?? undefined });
    console.log(JSON.stringify({ type: 'result', subtype: 'success' }));
    process.exit(0);
    break;
  }

  case 'ROTATE':
    writeEnvelope({
      outcome: 'ROTATE',
      handoff: evidenceFile(`${workerId}-continuation.md`),
      evidence: [evidenceFile(`${workerId}.md`)],
      detail: 'context exhausted; continuation brief written',
    });
    console.log(JSON.stringify({ type: 'result', subtype: 'error_max_turns' }));
    process.exit(0);
    break;

  case 'REPAIR_REQUIRED':
    writeEnvelope({
      outcome: 'REPAIR_REQUIRED',
      evidence: [evidenceFile(`${workerId}.md`)],
      detail: plan.repairDetail ?? 'the narrow validate command is still red',
    });
    process.exit(0);
    break;

  case 'BLOCKED':
    writeEnvelope({
      outcome: 'BLOCKED',
      trigger: plan.trigger ?? 3,
      options: plan.options ?? ['option A', 'option B'],
      evidence: [evidenceFile(`${workerId}.md`)],
    });
    process.exit(0);
    break;

  case 'FAILED':
    writeEnvelope({ outcome: 'FAILED', evidence: [evidenceFile(`${workerId}.md`)] });
    process.exit(0);
    break;

  case 'CRASH':
    console.error('fake worker: dying mid-node without an envelope');
    process.exit(9);
    break;

  case 'SILENT':
    // The dangerous one: a clean exit and confident output, with nothing on disk.
    console.log('All done! Everything passed and the phase is complete.');
    console.log(JSON.stringify({ type: 'result', subtype: 'success' }));
    process.exit(0);
    break;

  case 'HANG':
    setTimeout(() => process.exit(0), 10 * 60_000);
    break;

  default:
    console.error(`fake worker: unknown behaviour "${behaviour}"`);
    process.exit(4);
}
