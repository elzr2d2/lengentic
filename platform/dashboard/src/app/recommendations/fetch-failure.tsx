import type { RecommendationsFetchFailure } from '@/lib/recommendations-api';

/**
 * Renders why the recommendation data is not on screen, in the reader's terms.
 *
 * Three distinct causes, kept apart because they send you to three different places: the API
 * never answered, it answered with a status nobody expected, or it answered with a body that
 * is not the contract this page was built against. Collapsing them into "failed to load" would
 * make the third — a Dashboard and an API deployed at different versions — look like an outage,
 * and someone would restart a healthy service.
 *
 * `title` is a prop because the same three causes describe two different reads on this page:
 * the recommendation list and the analysis run. A card that always said "Recommendations
 * unavailable" would misname the failure of the Analyze action.
 */
export function RecommendationsFailureCard({
  title,
  failure,
}: {
  title: string;
  failure: RecommendationsFetchFailure;
}) {
  return (
    <section className="card">
      <h2 className="card-title">{title}</h2>
      <FailureRows failure={failure} />
    </section>
  );
}

function FailureRows({ failure }: { failure: RecommendationsFetchFailure }) {
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
          <Row label="Rejected by" value={<span className="value">@lengentic/shared</span>} />
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
