import type { RunDetailView, ToolCallView } from '@lengentic/shared/read';
import { readRunTelemetry, readToolCallClock } from '@/lib/run-telemetry';
import { formatDuration } from '@/lib/timeline';
import {
  Absence,
  IdField,
  InstantField,
  Mark,
  MetaRow,
  Payload,
  Tag,
  TextField,
} from './telemetry-parts';

/**
 * The Run Explorer's **Tool Calls** view — `MVP_PLAN_V3.md:1787`, "truncation flagged".
 *
 * ## Truncation travels with the payload
 *
 * The flag is rendered on the payload block itself (`Payload` in `./telemetry-parts`), not as
 * a count elsewhere on the card. §15's whole point is that truncation must lose the payload
 * and not the measurement, and `run-view.ts` names the failure this prevents: a response
 * "carrying `input` without `inputTruncated` / `inputBytes` would show a developer a complete
 * -looking tool input that is actually the first 32KB of one." A truncation notice a screen
 * away from the value it is about is the same failure with extra steps.
 *
 * The byte count shown is `inputBytes` / `outputBytes`, which the SDK measured **before** the
 * cap — so a 1MB output reads as 1MB lost sight of, not as the 32KB that survived.
 *
 * ## The clocks arrive unrepaired
 *
 * `startedAt`, `completedAt` and `durationMs` are all the caller's, and `run-view.ts` is
 * explicit that `durationMs` "is the client's own measurement and is not recomputed here".
 * A process whose clock stepped backwards therefore reaches this component with a completion
 * before its start, a negative duration, or both — and each is marked where a reader sees it
 * rather than clamped into agreement. A `0ms` in place of `-1000ms` would be the Dashboard
 * adjudicating between two measurements the caller made, which it has no basis to do.
 *
 * Nothing on this card compares the reported duration against the gap between the instants,
 * for the same reason.
 */
export function ToolCallsCard({ run }: { run: RunDetailView }) {
  const { toolCalls } = readRunTelemetry(run);

  return (
    <section className="card">
      <h2 className="card-title">Tool calls</h2>

      <p className="note-inline">
        Payloads are what survived &sect;15&rsquo;s redact-then-cap, client-side, before
        transmission. A truncated value is flagged on the payload itself, with the size it had
        before the cut. Instants and durations are the caller&rsquo;s clock, reported as sent.
      </p>

      <Absence presence={toolCalls.presence} plural="tool calls" />

      {toolCalls.presence === 'some' ? (
        <ul className="telemetry-list">
          {toolCalls.rows.map((call) => (
            <ToolCallRow key={call.id} call={call} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ToolCallRow({ call }: { call: ToolCallView }) {
  const clock = readToolCallClock(call);

  return (
    <li className="telemetry-row">
      <div className="telemetry-head">
        <span className="telemetry-name">{call.toolName}</span>
        {/* `success` is the stored column, not a derivation from `error` — the two can disagree
            and the response is what it is. Marked either way: a card that marked only failures
            makes "no mark" mean both "succeeded" and "this row did not render". */}
        <Mark tone={call.success ? 'succeeded' : 'failed'}>
          {call.success ? 'succeeded' : 'failed'}
        </Mark>
        {clock.instantsReversed ? (
          <Mark tone="cycle">reversed client clock &middot; completion precedes start</Mark>
        ) : null}
        {clock.durationNegative ? (
          <Mark tone="cycle">negative duration as reported by the caller</Mark>
        ) : null}
        <Tag tone={call.success ? 'muted' : 'down'}>{formatDuration(call.durationMs)}</Tag>
      </div>

      <div className="telemetry-fields">
        <InstantField label="Started" iso={call.startedAt} />
        <InstantField label="Completed" iso={call.completedAt} />
        {/* §13 leaves this unbounded: "an error message is captured evidence". Null on success,
            and rendered as `—` there rather than omitted, so the row shape never moves. */}
        <TextField label="Error" value={call.error} />
        <IdField label="Step" id={call.stepId} />
      </div>

      <Payload
        label="Input"
        value={call.input}
        bytes={call.inputBytes}
        truncated={call.inputTruncated}
      />
      <Payload
        label="Output"
        value={call.output}
        bytes={call.outputBytes}
        truncated={call.outputTruncated}
      />

      <MetaRow id={call.id} />
    </li>
  );
}
