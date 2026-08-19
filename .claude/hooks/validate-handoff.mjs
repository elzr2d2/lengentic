#!/usr/bin/env node
/**
 * Enforces `.claude/rules/handoff.schema.json` or `.claude/rules/lane-handoff.schema.json`
 * on agent output (MVP_PLAN.md §25, §36).
 *
 * Wired to SubagentStop. Reads the subagent's transcript, finds the last assistant
 * message, and looks for a handoff JSON object in it.
 *
 *   no JSON found        -> allow. Not every subagent returns a handoff, and blocking
 *                           Builder for not filing one would be wrong.
 *   JSON found, valid    -> allow.
 *   JSON found, invalid  -> exit 2. Claude Code surfaces stderr to the agent, which gets
 *                           a chance to correct the shape.
 *
 * Two contracts, not one. `handoff.schema.json` is a validation agent's FINDING about
 * someone else's work; `lane-handoff.schema.json` is a lane's report on its own — see the
 * lane schema's own description. The candidate's shape says which one it is meant to be:
 * a lane handoff always carries `task_id` (the graph node it was dispatched against) and
 * `handoff.schema.json` has `additionalProperties: false`, so validating a lane handoff
 * against it produces spurious "unexpected property" errors for every lane-only field.
 *
 * The permissive "no JSON" case is deliberate. A hook that blocks on absence would force
 * every agent to emit a handoff, which is not what §25 asks for — it asks that handoffs,
 * when made, have a checkable shape.
 *
 * Also runnable standalone, which is how the §35 harness validation proves it works:
 *   node .claude/hooks/validate-handoff.mjs --file report.json
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validate } from './lib/validate-schema.mjs';

const FINDING_SCHEMA_PATH = fileURLToPath(new URL('../rules/handoff.schema.json', import.meta.url));
const LANE_SCHEMA_PATH = fileURLToPath(
  new URL('../rules/lane-handoff.schema.json', import.meta.url),
);

function main() {
  const fileFlag = process.argv.indexOf('--file');
  if (fileFlag !== -1) {
    const path = process.argv[fileFlag + 1];
    if (!path) fail('--file requires a path');
    const candidate = JSON.parse(readFileSync(path, 'utf8'));
    report(validateCandidate(candidate), path, schemaPathFor(candidate));
    return;
  }

  const payload = readStdinJson();
  if (payload === null) process.exit(0); // Nothing to inspect; never block on our own bug.

  const candidate = lastHandoffCandidate(payload.transcript_path);
  if (candidate === null) process.exit(0);

  report(validateCandidate(candidate), 'agent output', schemaPathFor(candidate));
}

/** A lane handoff always names the dispatched node in `task_id`; a finding never does. */
function schemaPathFor(candidate) {
  return candidate && typeof candidate === 'object' && 'task_id' in candidate
    ? LANE_SCHEMA_PATH
    : FINDING_SCHEMA_PATH;
}

function validateCandidate(candidate) {
  const schema = JSON.parse(readFileSync(schemaPathFor(candidate), 'utf8'));
  return validate(candidate, schema);
}

function report(errors, source, schemaPath) {
  if (errors.length === 0) process.exit(0);
  const schemaName = schemaPath.endsWith('lane-handoff.schema.json')
    ? 'lane-handoff.schema.json'
    : 'handoff.schema.json';
  const hint =
    schemaName === 'lane-handoff.schema.json'
      ? [
          'Return a JSON object with: task_id, status, commit, changed_files, validation,',
          'acceptance_criteria, assumptions, risks, failures, follow_up_required,',
          'token_or_usage_summary. `evidence` is required for DONE, `blocker` for BLOCKED.',
        ]
      : [
          'Return a JSON object with: status, owner, failure, evidence, affectedArea,',
          'recommendedNextAction, confidence. `evidence` must be non-empty when status is',
          'FAILED or PASSED; `blocker` is required when status is BLOCKED.',
        ];
  process.stderr.write(
    [
      `Handoff report from ${source} does not match .claude/rules/${schemaName}:`,
      ...errors.map((e) => `  - ${e}`),
      '',
      ...hint,
      '',
    ].join('\n'),
  );
  process.exit(2);
}

function readStdinJson() {
  try {
    const raw = readFileSync(0, 'utf8');
    return raw.trim() === '' ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Pull the last assistant message out of a JSONL transcript and extract a handoff-shaped
 * JSON object from it, if one is there.
 */
function lastHandoffCandidate(transcriptPath) {
  if (typeof transcriptPath !== 'string') return null;

  let lines;
  try {
    lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return null;
  }

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry?.type !== 'assistant') continue;

    const text = textOf(entry.message?.content);
    return text === '' ? null : extractHandoff(text);
  }
  return null;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Find a JSON object carrying a `status` field — the marker that this was meant to be a
 * handoff rather than incidental JSON in prose. Scans from the end, so a final report wins
 * over an example quoted earlier in the message.
 */
function extractHandoff(text) {
  const candidates = [];

  const fenced = text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g);
  for (const match of fenced) candidates.push(match[1]);

  const braced = text.matchAll(/\{[\s\S]*?\n\}/g);
  for (const match of braced) candidates.push(match[0]);

  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(candidates[i]);
      if (parsed && typeof parsed === 'object' && 'status' in parsed) return parsed;
    } catch {
      /* not JSON, keep looking */
    }
  }
  return null;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

main();
