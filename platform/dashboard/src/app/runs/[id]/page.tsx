import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { RunDetailView, StepView } from '@lengentic/shared/read';
import { fetchRunDetail, fetchRunDroppedTelemetryEventCount } from '@/lib/runs-api';
import {
  buildStepTree,
  countStepNodes,
  describeStepAnomalies,
  type StepNode,
} from '@/lib/step-tree';
import { RunStatusBadge } from '../run-status-badge';
import { FetchFailureCard } from '../fetch-failure';
import { TimelineCard } from './timeline-card';
import { DecisionsCard } from './decisions-card';
import { ModelCallsCard } from './model-calls-card';
import { ToolCallsCard } from './tool-calls-card';
import { ErrorsCard } from './errors-card';
import { IngestionHealthCard } from './ingestion-health-card';

// Same reason as the list: `status` is derived per request from the server's clock.
export const dynamic = 'force-dynamic';

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await fetchRunDetail(id);

  // A 404 from the controller is "no such run", which is Next's own not-found page — not a
  // failure card claiming the API is unwell.
  if (result.kind === 'not-found') notFound();

  // ADR 0014 decision 2. A second, independent fetch — never throws, never blocks the rest
  // of the page — because `GET /v1/runs/:id` carries no drop count at all; `#23`'s roll-up
  // is a sibling resource (`runs.controller.ts`'s own reason: "the detail response is read
  // on every run page ... folding it in would make every detail read pay for it").
  const droppedTelemetryEventCount =
    result.kind === 'ok' ? await fetchRunDroppedTelemetryEventCount(id) : null;

  return (
    <>
      <h1>Run</h1>
      <p className="tagline">
        <Link href="/runs">&larr; All runs</Link>
      </p>

      {result.kind === 'ok' ? (
        <>
          <RunSummaryCard run={result.run} />
          {/* Timeline before hierarchy on purpose: the two are different orderings of the same
              steps — execution (client clock) and arrival (server clock) — and the required
              view list puts execution first (`MVP_PLAN_V3.md:1782-1784`). */}
          <TimelineCard run={result.run} />
          <StepsCard run={result.run} />
          {/* The remaining five of the eight required views, in the order
              `MVP_PLAN_V3.md:1779-1789` lists them. Ingestion Health is last on purpose: it is
              a reading *over* the four collections above, and a reader who meets "3 tool calls,
              1 truncated" before seeing the tool calls has nothing to attach it to.

              Every one of these cards renders unconditionally, including for a run that carried
              none of the collections. A card that hid itself when it had nothing to show would
              make "the API did not answer" and "this page does not have that view" identical on
              screen — which is the shape of the false green this node was reopened for. */}
          <DecisionsCard run={result.run} />
          <ModelCallsCard run={result.run} />
          <ToolCallsCard run={result.run} />
          <ErrorsCard run={result.run} />
          <IngestionHealthCard
            run={result.run}
            droppedTelemetryEventCount={droppedTelemetryEventCount}
          />
        </>
      ) : (
        <FetchFailureCard failure={result} />
      )}
    </>
  );
}

function RunSummaryCard({ run }: { run: RunDetailView }) {
  return (
    <section className="card">
      <h2 className="card-title">{run.workflowName ?? '(no run.started event yet)'}</h2>
      <Row label="Status" value={<RunStatusBadge status={run.status} />} />
      <Row
        label="Workflow version"
        value={<span className="value">{run.workflowVersion ?? '—'}</span>}
      />
      <Row label="Run id" value={<code>{run.id}</code>} />
      <Row label="Trace id" value={<code>{run.traceId}</code>} />
      <Row label="Started" value={<Instant iso={run.startedAt} />} />
      <Row label="Completed" value={<Instant iso={run.completedAt} />} />
      <Row label="Received" value={<Instant iso={run.receivedAt} />} />
      {/* The input to the STALE derivation, shown next to the derived status so the reader
          can check the server's arithmetic rather than take the verdict on trust. */}
      <Row label="Last event" value={<Instant iso={run.lastEventAt} />} />
    </section>
  );
}

function StepsCard({ run }: { run: RunDetailView }) {
  const tree = buildStepTree(run.steps);
  const rendered = countStepNodes(tree);
  const anomalies = describeStepAnomalies(tree);

  if (run.steps.length === 0) {
    return (
      <section className="card">
        <h2 className="card-title">Steps</h2>
        <p className="note-inline">No steps have been recorded against this run.</p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2 className="card-title">
        {String(run.steps.length)} step{run.steps.length === 1 ? '' : 's'}
        {anomalies}
      </h2>

      {/* `buildStepTree` places every step exactly once, and this compares its output against
          the response it was built from — so a placement that drops a step is visible on the
          page instead of looking like a run that genuinely had fewer steps.

          What it does NOT watch is this component. `rendered` counts nodes in the tree, and
          `StepBranch` below renders from that same tree, so both sides of the comparison move
          together: a `StepBranch` that stops recursing prints "4 steps" above a single `<li>`
          and this alarm stays silent. That gap was real and unwatched until the Phase 2 gate.
          The alarm for it is `../runs-pages.spec.ts`, "renders the whole step tree, nested",
          which reads the step ids and their nesting depth back out of the emitted markup —
          the only side of the comparison the tree cannot supply. */}
      {rendered === run.steps.length ? null : (
        <p className="note-inline note-alarm">
          {String(run.steps.length - rendered)} step(s) in the response are not on this page. That
          is a Dashboard defect, not a property of the run.
        </p>
      )}

      <StepBranch nodes={tree} />
    </section>
  );
}

function StepBranch({ nodes }: { nodes: readonly StepNode[] }) {
  return (
    <ul className="step-branch">
      {nodes.map((node) => (
        <li key={node.step.id} className="step-node">
          <div className="step-head">
            <span className="step-name">{node.step.name ?? '(no step.started event yet)'}</span>
            <PlacementMark node={node} />
            <span className={`status status-${stepTone(node.step.status)}`}>
              {node.step.status}
            </span>
          </div>
          <div className="step-meta">
            <code>{node.step.id}</code>
            {node.step.agentName === null ? null : (
              <span className="value">{node.step.agentName}</span>
            )}
            {node.step.type === null ? null : <span className="value">{node.step.type}</span>}
          </div>
          {node.children.length > 0 ? <StepBranch nodes={node.children} /> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Why this step sits where it sits.
 *
 * `nested` and `root` need no mark — the indentation already says it. The other two do: an
 * orphaned step rendered flush left is indistinguishable from a root step unless the page
 * says otherwise, and "silently promoted to root" asserts the step had no parent, which is a
 * claim about the run that the Dashboard has no basis for. The parent may just not have been
 * ingested yet.
 */
function PlacementMark({ node }: { node: StepNode }) {
  switch (node.placement) {
    case 'root':
    case 'nested':
      return null;
    case 'orphaned':
      return (
        <span className="placement placement-orphaned">
          orphaned &middot; parent <code>{node.step.parentStepId ?? '—'}</code> not in this run
        </span>
      );
    case 'cycle':
      return (
        <span className="placement placement-cycle">
          parent cycle &middot; <code>{node.step.parentStepId ?? '—'}</code> never reaches a root
        </span>
      );
  }
}

function stepTone(status: StepView['status']): 'ok' | 'live' | 'down' {
  switch (status) {
    case 'COMPLETED':
      return 'ok';
    case 'RUNNING':
      return 'live';
    case 'FAILED':
      return 'down';
  }
}

function Instant({ iso }: { iso: string | null }) {
  if (iso === null) return <span className="value">—</span>;

  // The raw ISO instant, not a locale format: the server rendering and the browser would
  // disagree on a locale string, and this is an observability tool where the exact instant
  // is the useful value.
  return (
    <time className="value" dateTime={iso}>
      {iso}
    </time>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      {value}
    </div>
  );
}
