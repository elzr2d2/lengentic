#!/usr/bin/env node
/**
 * Enforces `.claude/rules/handoff.schema.json` on agent output (MVP_PLAN.md §25, §36).
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

const SCHEMA_PATH = fileURLToPath(new URL('../rules/handoff.schema.json', import.meta.url));

function main() {
  const fileFlag = process.argv.indexOf('--file');
  if (fileFlag !== -1) {
    const path = process.argv[fileFlag + 1];
    if (!path) fail('--file requires a path');
    report(validateCandidate(JSON.parse(readFileSync(path, 'utf8'))), path);
    return;
  }

  const payload = readStdinJson();
  if (payload === null) process.exit(0); // Nothing to inspect; never block on our own bug.

  const candidate = lastHandoffCandidate(payload.transcript_path);
  if (candidate === null) process.exit(0);

  report(validateCandidate(candidate), 'agent output');
}

function validateCandidate(candidate) {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  return validate(candidate, schema);
}

function report(errors, source) {
  if (errors.length === 0) process.exit(0);
  process.stderr.write(
    [
      `Handoff report from ${source} does not match .claude/rules/handoff.schema.json:`,
      ...errors.map((e) => `  - ${e}`),
      '',
      'Return a JSON object with: status, owner, failure, evidence, affectedArea,',
      'recommendedNextAction, confidence. `evidence` must be non-empty when status is',
      'FAILED — an unevidenced failure is an opinion.',
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
