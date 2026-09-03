import { describeCollection, formatByteCount, type CollectionPresence } from '@/lib/run-telemetry';

/**
 * The vocabulary the five Phase 4 cards are built from.
 *
 * One module rather than five copies, for a reason narrower than "shared components": these
 * cards all render the same three-state absence and the same nullable measurement, and the
 * failure mode is a single card quietly saying `0` or `—` where the others say what happened.
 * Five copies of {@link Absence} would be five places to get that wrong; one is one.
 *
 * `Instant` is duplicated from `page.tsx` / `timeline-card.tsx` rather than hoisted here.
 * Those two are the Phase 2 cards and are outside this packet's blast radius (`REFAC-3`);
 * touching them to save eight lines is a change no acceptance criterion asks for.
 */

/**
 * The sentence a card shows where its rows would have been — and nothing when it has rows.
 *
 * The absent case gets `note-absent` on top of `note-inline` so it reads differently from the
 * answered one. The two sentences already differ (`describeCollection`); the class is what
 * stops a reader skimming past a gap in the response as though it were a finding about the run.
 */
export function Absence({ presence, plural }: { presence: CollectionPresence; plural: string }) {
  if (presence === 'some') return null;

  return (
    <p className={presence === 'absent' ? 'note-inline note-absent' : 'note-inline'}>
      {describeCollection(presence, plural)}
    </p>
  );
}

/** One `label → value` pair inside a telemetry row. Never nests, so a reader can scan it. */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {children}
    </div>
  );
}

/**
 * A field whose value the response may not have carried.
 *
 * `'—'` and not `''`: a blank is indistinguishable from a row the page failed to render, and
 * §14 makes null a real, expected value on most of a Decision's columns rather than a defect.
 */
export function TextField({ label, value }: { label: string; value: string | null }) {
  return (
    <Field label={label}>
      <span className="value">{value ?? '—'}</span>
    </Field>
  );
}

/** A field carrying an id — same `<code>` treatment the Steps and Timeline cards give one. */
export function IdField({ label, id }: { label: string; id: string | null }) {
  return (
    <Field label={label}>
      {id === null ? <span className="value">—</span> : <code>{id}</code>}
    </Field>
  );
}

/** A field carrying a client or server instant, as the raw ISO string the pages use. */
export function InstantField({ label, iso }: { label: string; iso: string | null }) {
  return (
    <Field label={label}>
      {iso === null ? (
        <span className="value">—</span>
      ) : (
        <time className="value" dateTime={iso}>
          {iso}
        </time>
      )}
    </Field>
  );
}

/**
 * Why this row is not the ordinary case.
 *
 * Same element and the same job as the Steps card's `PlacementMark` and the Timeline's
 * `ShapeMark`, deliberately: a reader who has learned what a bordered mono chip means on one
 * card should not have to learn it again on the next.
 */
export function Mark({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`placement placement-${tone}`}>{children}</span>;
}

/**
 * The row's headline value — an outcome, a latency, a duration.
 *
 * `tone` is required rather than optional: `muted` is a real choice ("this value carries no
 * verdict") and every call site should have made it deliberately. An optional tone would let a
 * failure render in the ordinary colour because someone forgot the prop.
 */
export function Tag({ tone, children }: { tone: TagTone; children: React.ReactNode }) {
  return <span className={`telemetry-tag telemetry-tag-${tone}`}>{children}</span>;
}

export type TagTone = 'ok' | 'down' | 'muted';

/**
 * The row's own identity line, and the id is always first.
 *
 * Every card's rows end with this, so a reader who wants to correlate a decision with a tool
 * call — or with a row in the database — has the id in the same place each time.
 */
export function MetaRow({ id, children }: { id: string; children?: React.ReactNode }) {
  return (
    <div className="telemetry-meta">
      <code>{id}</code>
      {children}
    </div>
  );
}

/**
 * An arbitrary JSON payload, with its label and — where §15 truncated it — its true size.
 *
 * **The label carries the truncation flag, not a summary line elsewhere on the card.** §15's
 * point is that truncation must lose the payload and not the measurement, so a payload shown
 * anywhere near a reader without its flag reads as a complete value; putting the flag in a
 * count at the bottom of the page separates the two exactly where it matters.
 *
 * `undefined` renders nothing at all, because that is a field the response did not carry.
 * `null` renders as `null`, because that is a value the response did carry. Same distinction
 * as everywhere else in this packet, one level down.
 *
 * The body is not shortened here. Whatever survived §15's 32KB cap is what the reader is
 * shown; `.payload-body` scrolls instead, so nothing the page hides is invisible to it.
 *
 * `bytes: number | null` (Reviewer S3, Phase 4 phase gate repair attempt 1): `null` is a
 * call recorded with `captureToolIO: false`, where nothing was measured at all —
 * `formatByteCount` already renders that as "not reported" rather than a manufactured `0`.
 * `truncated` is always `false` for such a call (`payload-safety.ts`'s `toolIO`), so the
 * truncated branch below never actually sees a `null` `bytes`, but the type says what is
 * true rather than what happens to hold today.
 */
export function Payload({
  label,
  value,
  bytes,
  truncated,
}: {
  label: string;
  value: unknown;
  bytes: number | null;
  truncated: boolean;
}) {
  if (value === undefined) return null;

  return (
    <div className={truncated ? 'payload payload-truncated' : 'payload'}>
      <span className="payload-label">
        {truncated
          ? `${label} · truncated · ${formatByteCount(bytes)} before the cap`
          : `${label} · ${formatByteCount(bytes)}`}
      </span>
      <pre className="payload-body">{stringify(value)}</pre>
    </div>
  );
}

/**
 * A payload that carries no size measurement of its own — a Decision's `rawContext`, an
 * Error's `metadata`. §15 caps these client-side too, but no byte column travels with them,
 * so the card must not print a size it would have to invent.
 */
export function UnsizedPayload({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null) return null;

  return (
    <div className="payload">
      <span className="payload-label">{label}</span>
      <pre className="payload-body">{stringify(value)}</pre>
    </div>
  );
}

/**
 * JSON, or a named failure.
 *
 * `JSON.stringify` throws on a `BigInt` and returns `undefined` for a function — neither of
 * which can survive `JSON.parse` in `runs-api.ts`, so this branch is unreachable through the
 * real read path. It is here because a payload that failed to render must say so: a `<pre>`
 * containing the string `undefined` reads as a tool that returned the word "undefined".
 */
function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '(this value has no JSON representation)';
  } catch {
    return '(this value could not be rendered as JSON)';
  }
}
