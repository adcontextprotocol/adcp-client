# Reporting interoperability evidence

The gate installs and verifies the packed TypeScript SDK and reporting-storage
artifacts alongside the immutable Python wheel and harness recorded in `pins.json`.
Run `run.mjs` through `.github/workflows/interop-python.yml`; it executes both
fixture-evidence directions and the real PostgreSQL/MCP runtime checks.

In `reporting_evidence_interop_v1` results, the historical `adcp_schema_version`
field is the Python wheel/harness pin, also named `python_adcp_schema_version`.
`typescript_adcp_schema_version` records the candidate seller protocol and must
match both this checkout and the installed SDK. `fixture_adcp_schema_version`
records the separate contract fixture used by the managed/billing buyers. These
values may differ: successful runtime checks establish the tested interoperability
pairings rather than relabelling the independently verified artifacts. Standalone
seller results record `seller_adcp_version`; Core also records its pinned buyer
protocol. GCS preflight uses the Python pin, while its managed buyer uses the
contract fixture, as in the local managed gate.
