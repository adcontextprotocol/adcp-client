# Current candidate repeats the reporting qualification failure

AdCP #7508 candidate `fc488660c1501d3cb9db71ee3ecfad8316ee924a` failed
[Generate TypeScript SDK, job 104038964777](https://github.com/adcontextprotocol/adcp/actions/runs/34862418515/job/104038964777)
on 2026-09-14 at 15:57:43 UTC. The full job log confirms SDK checkout
`90ad47b67401d35e0a9ffc99fd0e76252e026a9a` and the same TS2322 at
`src/lib/reporting/ledger/status-ingest.ts(288,13)`: generated `content_mismatch`
is not assignable to `ReportingLedgerConsumerStatusInputV1`.

The [error excerpt](./reporting-content-mismatch-fc488-failure.txt) and
[immutable identifiers and hashes](./reporting-content-mismatch-fc488.json)
preserve this additional reproduction. It establishes that the blocker is not
confined to the earlier `c594` candidate documented in the
[original evidence](./reporting-content-mismatch.md).

The current candidate's canonical consumer-status schema and qualification
workflow are byte-identical to those already audited. Its separate rc.4 bundle
has SHA-256 `82c1932c2d1cc068c6ae99f4ac6710039210332d16ca1e1859cc2849fa029cfc`
(artifact `10356276302`, run `34862418515`). Download it with:

```sh
gh run download 34862418515 --repo adcontextprotocol/adcp \
  --name schema-pr-bundle-fc488660c1501d3cb9db71ee3ecfad8316ee924a --dir bundle
(cd bundle && sha256sum -c latest.tgz.sha256)
```

Verify the provenance source commit and the tarball digest above before replaying
the [pinned qualification step](https://github.com/adcontextprotocol/adcp/blob/fc488660c1501d3cb9db71ee3ecfad8316ee924a/.github/workflows/validate-schema-bundle.yml#L124)
using the preparation described in the original evidence. The failed workflow
used Node 24, synchronized the disposable SDK metadata to the bundle, and ran
`sync-schemas`, `generate-types`, `validate-schemas`, and `build:lib`. Downloading
this evidence does not rerun the AdCP workflow.

## Type and runtime guarantees

The ledger's accepted wire fields and status union derive from the generated
TypeScript type. Compile-only assertions check their agreement. Conditional
required/forbidden combinations, including `mismatch_code` requirements, are
**enforced at runtime by the generated Zod checks**, with tests against the
canonical JSON Schema. The TypeScript interface does not encode those
conditional combinations as a discriminated union.

The focused four-file selection is identical across qualification checkouts:

```sh
node --test --test-timeout=60000 --test-force-exit \
  test/generate-zod-consumer-status-content-mismatch.test.js \
  test/generate-zod-consumer-status.test.js \
  test/lib/reporting-status-ingest-validation.test.js \
  test/lib/reporting-status-ingest-pg.test.js
```

Run with PostgreSQL configured through `REPORTING_LEDGER_PG_URL`; record the exact
SDK head, protocol pin, command, and test total with each result. The current-pin
four-file selection was verified as 47/47. Earlier descriptions using 45 for rc.2
and 47 for rc.4 should not be read as a comparison of different test selections.

This additional evidence does not close AdCP #7404 or establish full reporting
conformance. The separate seller-starter `targeting_overlay.geo_countries`
nullability workstream is not part of this reporting patch. AdCP #7508 stays
Draft until the SDK fix lands on main, the release branch is regenerated from
current AdCP main, and its exact Generate TypeScript SDK check passes. The SDK PR
stays Draft with auto-merge off; no merge or publication is performed here.
