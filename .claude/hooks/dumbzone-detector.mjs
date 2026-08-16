#!/usr/bin/env node
/**
 * Warns when the session is drifting into the "dumb zone" (Matt Pocock).
 *
 * An agent reasons sharply early in a session, then degrades as the context window fills:
 * a fixed per-token attention budget competing with an ever-growing window. The fix is to
 * REMOVE context (/clear, /compact, fresh session), not to add more. This hook nudges the
 * human before the quality drop-off bites.
 *
 * Wired to UserPromptSubmit. It measures the *actual* prompt size from the transcript's most
 * recent assistant turn (input + cache tokens) rather than guessing from characters, and it
 * only warns — it never blocks a prompt. A hook that can fail a task is a hook that gets
 * disabled, and the Coordinator legitimately runs long integrations.
 *
 * The three thresholds are Pocock's published numbers, not invented ones: the smart zone is
 * the first ~100K tokens "no matter how large the window claims to be"; he starts handing off
 * at ~120K; the dumb zone "commonly begins around 125K-150K tokens - though this is debated".
 * A 1M window does not move them — it ships more dumb zone. Env-overridable so behaviour can
 * be tuned without editing code:
 *   DUMBZONE_WARN_AT     (default 100000)  leaving the smart zone
 *   DUMBZONE_HANDOFF_AT  (default 120000)  write the handoff now
 *   DUMBZONE_LIMIT_AT    (default 150000)  deep in the dumb zone
 *
 * The 120K tier names `/session-handoff` because a nudge that names its command gets used.
 * That skill name and this string are one contract — change one, change the other.
 */

import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';

const WARN_AT = Number(process.env.DUMBZONE_WARN_AT ?? 100_000);
const HANDOFF_AT = Number(process.env.DUMBZONE_HANDOFF_AT ?? 120_000);
const LIMIT_AT = Number(process.env.DUMBZONE_LIMIT_AT ?? 150_000);

/** Only the tail of the transcript is read: the answer is always in the last few records. */
const TAIL_BYTES = 512 * 1024;

/** Total input size of the most recent assistant turn, or null if unmeasurable. */
function contextTokens(transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return null;

  let text;
  try {
    const { size } = statSync(transcriptPath);
    if (size <= TAIL_BYTES) {
      text = readFileSync(transcriptPath, 'utf8');
    } else {
      const fd = openSync(transcriptPath, 'r');
      try {
        const buffer = Buffer.alloc(TAIL_BYTES);
        const read = readSync(fd, buffer, 0, TAIL_BYTES, size - TAIL_BYTES);
        // The first line is almost certainly cut mid-record; the parse loop discards it.
        text = buffer.subarray(0, read).toString('utf8');
      } finally {
        closeSync(fd);
      }
    }
  } catch {
    return null;
  }

  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = event?.message?.usage;
    if (usage && typeof usage === 'object') {
      return (
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0)
      );
    }
  }
  return null;
}

/**
 * A horizontal bar of context usage that grades green -> red as it fills.
 *
 * Each filled cell is coloured by how close its slice of the context is to the dumb-zone line
 * (LIMIT_AT): green safe -> yellow -> orange -> red past the line. Remaining headroom is shown
 * as white. Emoji squares are used (not ANSI colour codes) so the gradient renders as real
 * colour wherever the warning is shown.
 */
function gauge(tokens, width = 14) {
  const niceMax = (Math.floor(Math.max(tokens, LIMIT_AT) / 50_000) + 1) * 50_000;
  const fill = Math.max(0, Math.min(width, Math.round((tokens / niceMax) * width)));

  const cells = [];
  for (let i = 0; i < width; i += 1) {
    if (i >= fill) {
      cells.push('⬜'); // remaining headroom
      continue;
    }
    const f = (((i + 0.5) / width) * niceMax) / LIMIT_AT; // 1.0 == dumb-zone line
    if (f < 0.5) cells.push('🟩');
    else if (f < 0.8) cells.push('🟨');
    else if (f < 1.0) cells.push('🟧');
    else cells.push('🟥');
  }
  return `${cells.join('')}  ~${Math.floor(tokens / 1000)}K / dumb ≥${Math.floor(LIMIT_AT / 1000)}K`;
}

try {
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  const tokens = contextTokens(payload?.transcript_path);

  // Smart zone (or unmeasurable) — stay quiet.
  if (tokens !== null && tokens >= WARN_AT) {
    const k = Math.floor(tokens / 1000);
    const limitK = Math.floor(LIMIT_AT / 1000);
    const chart = gauge(tokens);

    let systemMessage;
    let additionalContext;

    if (tokens >= LIMIT_AT) {
      systemMessage =
        `🔴 Dumb zone: ~${k}K tokens of context. Reasoning quality degrades sharply past ` +
        `~${limitK}K (Matt Pocock's 'dumb zone'). Run /session-handoff, then /clear.\n${chart}`;
      additionalContext =
        `CONTEXT WARNING: this session is deep in the 'dumb zone' (~${k}K tokens). ` +
        `Instruction-following and code quality degrade here. Do not begin new work in this ` +
        `window. Finish or hand off what is in flight: invoke the \`session-handoff\` skill to ` +
        `write the continuation brief, then tell the human to /clear.`;
    } else if (tokens >= HANDOFF_AT) {
      systemMessage =
        `🟠 Hand off now: ~${k}K tokens of context. This is where Pocock stops trusting the ` +
        `window (dumb zone ~${limitK}K). Run /session-handoff, then /clear.\n${chart}`;
      additionalContext =
        `CONTEXT NOTE: session context is ~${k}K tokens — the point where a handoff is cheaper ` +
        `than pushing on. If the current task is not one step from done, invoke the ` +
        `\`session-handoff\` skill now and tell the human to /clear; the next session picks it ` +
        `up automatically from .artifacts/handoffs/session/.`;
    } else {
      systemMessage =
        `🟡 Leaving the smart zone: ~${k}K tokens of context (hand off ~${Math.floor(
          HANDOFF_AT / 1000,
        )}K, dumb zone ~${limitK}K). Good moment to wrap up this task or /clear before the ` +
        `next one.\n${chart}`;
      additionalContext =
        `CONTEXT NOTE: session context is ~${k}K tokens, past the smart zone. Keep scope tight; ` +
        `a /clear between tasks will keep responses sharp.`;
    }

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext,
        },
        systemMessage,
      }),
    );
  }
} catch {
  /* A context nudge never fails a prompt. */
}

process.exit(0);
