# Reporting consumer status bundle qualification

AdCP #7508 at `c59427cde5025f273126cc639885f5ce85984df0` failed
[Generate TypeScript SDK, job 104010429918](https://github.com/adcontextprotocol/adcp/actions/runs/34854119276/job/104010429918)
against SDK main `90ad47b67401d35e0a9ffc99fd0e76252e026a9a`.
The generated `content_mismatch` status was not assignable to the handwritten
ledger input. The [original error excerpt](./reporting-content-mismatch-failure.txt)
and [immutable inputs and checksums](./reporting-content-mismatch.json) preserve
the cross-repository reproduction identity.

The canonical [AdCP main schema](https://github.com/adcontextprotocol/adcp/blob/98fa207cb81c14b745f66a90d0b82cb6fad82f4b/specs/schemas/source/core/reporting-consumer-status.json)
and the candidate bundle schema differ only in `$id`. This contract came from
source/rc.3 (#7465); #7508 did not introduce the mismatch. An unmodified source
copy is retained in `test/fixtures/reporting-consumer-status/canonical-rc3.json`.

## Contract audit

`content_mismatch` requires `reporting_obligation_id`, `reporting_revision_id`,
`observed_revision_content_sha256`, and `mismatch_code`; it forbids `failure_code`.
All four preceding statuses forbid `mismatch_code`. The six canonical reasons
are `scope_media_buy_missing`, `coverage_short`, `metric_missing`,
`schema_nonconformant`, `currency_mismatch`, and `period_mismatch`. This is an
operational contract disagreement, not a measurement dispute or billing acceptance.

The SDK's generated Zod postprocessor also had an rc.2 field whitelist and
conditional rules, so fixing only the TypeScript union would still reject valid
mismatch codes. Ledger wire fields now derive from `ReportingConsumerStatus`,
and required/forbidden rules derive from the pinned canonical schema. The parser
retains the code; `status-ingest` passes the entire parsed statement into storage.
PostgreSQL persists the statement as JSONB, semantic fingerprints cover all wire
fields, and both sync results and status readback omit only internal account and
principal fields. Existing non-received health projection treats the mismatch as
`CONSUMER_STATUS_MISMATCH`, attributed to the seller with `contact_seller`.
The observed digest receives the same revision-binding check as `received`.

The envelope-only raw server dispatcher intentionally leaves item parsing to the
handler so invalid items do not reject valid siblings. Generated client, server,
and protocol adapters pass these wire fields through; no alternate enum mapper
or persistence column needs widening.

The SDK stays on its existing protocol pin. This patch repairs generation from
newer bundles; adopting a new protocol version remains a separate regeneration.
The patch changeset follows the repository's existing `rc` prerelease mode and
does not edit package versions.

## Reproduce the qualification

Use Node 24 and a disposable SDK checkout. Download the original artifact while
GitHub retains it:

```sh
gh run download 34854119276 --repo adcontextprotocol/adcp \
  --name schema-pr-bundle-c59427cde5025f273126cc639885f5ce85984df0 --dir bundle
(cd bundle && sha256sum -c latest.tgz.sha256)
```

Require the digest `3bd8ddba0dafc6ecb92864f6bd97d28c7d69ff9d6a700a1596838297cee9be32`
and provenance source commit `c59427cde5025f273126cc639885f5ce85984df0` before
using that bundle. The original tarball, sidecars, complete job log, and local
validation logs are preserved under `.context/content-mismatch-evidence/` in the
implementation workspace. GitHub artifact retention is finite; the checksums,
source snapshot, and failure excerpt above remain in Git.

Check out SDK base `90ad47b67401d35e0a9ffc99fd0e76252e026a9a` to reproduce the
failure, or the fix's exact reviewed commit to validate it. Run `npm ci`, then
use the **Generate and build from the PR bundle** step verbatim from the
[pinned workflow](https://github.com/adcontextprotocol/adcp/blob/c59427cde5025f273126cc639885f5ce85984df0/.github/workflows/validate-schema-bundle.yml#L124).
It expects sibling `sdk/` and `bundle/` directories, `PR_HEAD_SHA` set to the
candidate commit, and writable `RUNNER_TEMP` and `GITHUB_STEP_SUMMARY` paths.
It checks provenance, aligns only disposable protocol metadata, serves the bundle
locally, and runs `sync-schemas`, `generate-types`, `validate-schemas`, and
`build:lib`. Primary schema fallback is disabled. Historical caches use the
normal public host, as in the failed job.

The forward fixture test runs even under the SDK's rc.2 pin. The reporting
validation and PostgreSQL roundtrip tests enumerate the pinned bundle's status
contract; after candidate generation they exercise all five statuses and all six
mismatch codes through parsing, persistence, replay, and readback. Run them with:

```sh
npm run typecheck
REPORTING_LEDGER_PG_URL=postgres://USER@127.0.0.1/DATABASE \
  node --test --test-timeout=60000 --test-force-exit \
  test/generate-zod-consumer-status-content-mismatch.test.js \
  test/generate-zod-consumer-status.test.js \
  test/lib/reporting-status-ingest-validation.test.js \
  test/lib/reporting-status-ingest-pg.test.js
```

## Handoff

AdCP #7508 must remain **Draft** until this SDK fix lands on `adcp-client` main,
its release branch is regenerated from current AdCP main, and the exact
**Generate TypeScript SDK** check passes. A local pass against the pinned
candidate is evidence for this SDK fix, not qualification of a future release
head. This work does not close AdCP #7404 or the reporting framework.

Only a Draft SDK PR is authorized. Human maintainers own review and landing;
auto-merge stays off. No merge, npm publication, release, tag, modification to
AdCP #7508, workflow rerun/cancellation, or branch-protection change is part of
this handoff.
