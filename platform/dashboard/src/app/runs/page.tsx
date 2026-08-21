import Link from 'next/link';
import type { RunListView, RunSummaryView, RunsListQuery } from '@lengentic/shared/read';
import { fetchRunList, parseRunsListQuery } from '@/lib/runs-api';
import { RunStatusBadge } from './run-status-badge';
import { FetchFailureCard } from './fetch-failure';

// A run list that renders a cached snapshot is a run list that lies: `status` is derived
// from the server's clock on every request, so a cached page shows a stale `RUNNING`.
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

export default async function RunsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { query, rejected } = parseRunsListQuery(await searchParams);
  const result = await fetchRunList(query);

  return (
    <>
      <h1>Runs</h1>
      <p className="tagline">
        <Link href="/">&larr; Platform status</Link>
      </p>

      {rejected ? (
        <p className="note-inline">
          The query string was not a valid page (limit 1&ndash;200, offset 0 or more). Showing the
          first page instead.
        </p>
      ) : null}

      {result.kind === 'ok' ? (
        <RunList list={result.list} />
      ) : (
        <FetchFailureCard failure={result} />
      )}
    </>
  );
}

function RunList({ list }: { list: RunListView }) {
  if (list.runs.length === 0) {
    return (
      <section className="card">
        <h2 className="card-title">No runs</h2>
        <p className="note-inline">
          {list.offset === 0
            ? 'The API has recorded no runs yet. Send a batch through the telemetry SDK and reload.'
            : 'This page is past the end of the list.'}
        </p>
        <Pager list={list} />
      </section>
    );
  }

  return (
    <section className="card">
      <h2 className="card-title">
        {String(list.runs.length)} run{list.runs.length === 1 ? '' : 's'} &middot; from{' '}
        {String(list.offset + 1)}
      </h2>

      <ul className="run-list">
        {list.runs.map((run) => (
          <RunRow key={run.id} run={run} />
        ))}
      </ul>

      <Pager list={list} />
    </section>
  );
}

function RunRow({ run }: { run: RunSummaryView }) {
  return (
    <li className="run-row">
      <Link className="run-row-main" href={`/runs/${encodeURIComponent(run.id)}`}>
        <span className="run-row-name">{run.workflowName ?? '(no run.started event yet)'}</span>
        <span className="run-row-version">{run.workflowVersion ?? '—'}</span>
      </Link>
      <div className="run-row-meta">
        <RunStatusBadge status={run.status} />
        {/* `lastEventAt` is the sole input to the STALE derivation, so it is on the row that
            shows the derived status — otherwise STALE is a verdict with its evidence hidden. */}
        <time className="value" dateTime={run.lastEventAt}>
          {run.lastEventAt}
        </time>
        <code>{run.id}</code>
      </div>
    </li>
  );
}

/**
 * Paging is offset-based because that is what `RunsListQuerySchema` accepts, and `hasMore`
 * is the API's own answer rather than `runs.length === limit`, which is wrong on the exact
 * last page.
 */
function Pager({ list }: { list: RunListView }) {
  const previousOffset = Math.max(0, list.offset - list.limit);

  return (
    <div className="pager">
      {list.offset > 0 ? (
        <Link href={pageHref({ limit: list.limit, offset: previousOffset })}>&larr; Newer</Link>
      ) : (
        <span className="pager-disabled">&larr; Newer</span>
      )}
      {list.hasMore ? (
        <Link href={pageHref({ limit: list.limit, offset: list.offset + list.limit })}>
          Older &rarr;
        </Link>
      ) : (
        <span className="pager-disabled">Older &rarr;</span>
      )}
    </div>
  );
}

function pageHref(query: RunsListQuery): string {
  return `/runs?limit=${String(query.limit)}&offset=${String(query.offset)}`;
}
