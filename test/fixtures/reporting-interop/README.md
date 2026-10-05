These are versioned test vectors, not reporting data returned to SDK callers.

`canonical-json-v1.json` pins the shared evidence encoding. `evidence-v1.json`
pins official revision/materialization context and seven adjustment/receipt
cases. `resources/fixture.json` binds the exact bytes consumed by both manifest
inspectors. The row schema avoids regex keywords because Python's inspector
rejects them; decimal values remain strings and are independently aggregated.

The named canonicalization vectors follow AdCP 3.2.1: an exact empty report,
plus a case that exercises both row ordering and object-member ordering.
Existing array-shaped contracts remain covered by the older reconciliation
fixtures; these files do not replace or rewrite their immutable hashes.

Python and TypeScript use different SDK-defined rejection codes for a tampered
adjustment digest. `expected_python_receipt` records that difference explicitly;
the independently observed digest and rejection status must still agree.

Changes require a fixture-version decision and execution of
`scripts/reporting-interop/run.mjs` with both installed SDK artifacts. See
`docs/development/RELIABLE-REPORTING-PARITY.md` for exact coverage and remaining
runtime qualification gaps.
