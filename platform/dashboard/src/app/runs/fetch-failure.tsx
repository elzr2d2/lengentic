import type { RunsFetchFailure } from '@/lib/runs-api';

/**
 * Renders why the Run data is not on screen, in the reader's terms.
 *
 * Three distinct causes, kept apart because they send you to three different places: the API
 * never answered, it answered with a status nobody expected, or it answered with a body that
 * is not the contract this page was built against. Collapsing them into "failed to load"
 * would make the third — a Dashboard and an API deployed at different versions — look like
 * an outage, and someone would restart a healthy service.
 */
export function FetchFailureCard({ failure }: { failure: RunsFetchFailure }) {
  return (
    <section className="card">
      <h2 className="card-title">Runs unavailable</h2>
      <FailureRows failure={failure} />
    </section>
  );
}

function FailureRows({ failure }: { failure: RunsFetchFailure }) {
  switch (failure.kind) {
    case 'unreachable':
      return (
        <>
          <Row label="API" value={<span className="status status-down">unreachable</span>} />
          <Row label="Endpoint" value={<code>{failure.endpoint}</code>} />
          <Row label="Reason" value={<span className="value">{failure.reason}</span>} />
        </>
      );
    case 'http-error':
      return (
        <>
          <Row
            label="API"
            value={<span className="status status-down">HTTP {String(failure.httpStatus)}</span>}
          />
          <Row label="Endpoint" value={<code>{failure.endpoint}</code>} />
        </>
      );
    case 'invalid':
      return (
        <>
          <Row label="API" value={<span className="status status-warn">contract mismatch</span>} />
          <Row label="Endpoint" value={<code>{failure.endpoint}</code>} />
          <Row label="Rejected by" value={<span className="value">@lengentic/shared/read</span>} />
          <Row label="Reason" value={<span className="value">{failure.reason}</span>} />
        </>
      );
  }
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      {value}
    </div>
  );
}
