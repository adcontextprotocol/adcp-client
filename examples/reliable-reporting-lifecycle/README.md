# Reliable Reporting lifecycle reference

This example wires `createAdcpServer`, `PostgresReportingLedgerStore`, a simulated source executor, and the seller worker. The source exposes deterministic controls for not-ready, zero-row, failure, restatement, and official evidence. Its `reporting_core_lifecycle_probe` control is intentionally transport-neutral so a compliance adapter can expose it through its test-controller route.

```bash
docker compose -f examples/reliable-reporting-lifecycle/docker-compose.yml up -d
export REPORTING_LIFECYCLE_PG_URL=postgres://postgres@127.0.0.1:55440/reporting
npm run build
node --test test/reliable-reporting-lifecycle-pg.test.js
```

The integration test drives period close, visible waiting obligations, delayed and action-required deadlines, exact bound reads, real zero rows, snapshot restatement, official terminality, and immutable adjustments. It also feeds the resulting ledger through the existing buyer-side `reconcileReporting` path.
