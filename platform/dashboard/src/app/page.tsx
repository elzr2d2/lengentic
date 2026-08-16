import { fetchHealth, type HealthResult } from '@/lib/api';

// A status page that renders a cached snapshot is a status page that lies.
export const dynamic = 'force-dynamic';

export default async function StatusPage() {
  const health = await fetchHealth();

  return (
    <>
      <h1>LenGentic</h1>
      <p className="tagline">Agent Observability &amp; Decision Intelligence Platform</p>

      <section className="card">
        <h2 className="card-title">Platform status</h2>
        <PlatformStatus health={health} />
      </section>

      <p className="note">
        Phase 1 of 7. This page exists to prove the Dashboard reaches the API and the API reaches
        PostgreSQL. Runs, Steps, and the Run Explorer arrive in Phase 2.
      </p>
    </>
  );
}

function PlatformStatus({ health }: { health: HealthResult }) {
  if (health.kind === 'unreachable') {
    return (
      <>
        <Row label="API" value={<Status state="down">unreachable</Status>} />
        <Row label="Database" value={<Status state="down">unknown</Status>} />
        <Row label="Endpoint" value={<code>{health.endpoint}/health</code>} />
        <Row label="Reason" value={<span className="value">{health.reason}</span>} />
      </>
    );
  }

  const { report, httpStatus } = health;
  const databaseUp = report.checks.database === 'up';

  return (
    <>
      <Row
        label="API"
        // The API answered, so it is up. A 503 here means a dependency is down, not the
        // API — conflating the two sends you restarting the wrong service.
        value={<Status state="ok">up · HTTP {httpStatus}</Status>}
      />
      <Row
        label="Database"
        value={<Status state={databaseUp ? 'ok' : 'down'}>{databaseUp ? 'up' : 'down'}</Status>}
      />
      <Row
        label="Overall"
        value={<Status state={report.status === 'ok' ? 'ok' : 'warn'}>{report.status}</Status>}
      />
      <Row label="Uptime" value={<span className="value">{report.uptimeSeconds}s</span>} />
    </>
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

function Status({ state, children }: { state: 'ok' | 'warn' | 'down'; children: React.ReactNode }) {
  return <span className={`status status-${state}`}>{children}</span>;
}
