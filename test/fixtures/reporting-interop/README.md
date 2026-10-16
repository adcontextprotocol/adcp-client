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

## The actors do not share one protocol version

Three distinct AdCP protocol versions are in play, and conflating them is what
broke the gate when this SDK adopted 3.2.5:

- **TypeScript seller** — the SDK's own `adcp_version`, read from this checkout
  and required to equal the installed `@adcp/sdk`. It is built from source here,
  so it moves whenever the SDK adopts a new bundle.
- **Core Python buyer** — `scripts/reporting-interop/pins.json`
  `adcp_schema_version`. That records the protocol the independently verified
  Python wheel and pinned harness were validated against. The artifact is
  immutable, so this value only changes when a new Python artifact is verified.
- **Managed and GCS Python buyers** — `evidence-v1.json` `adcp_schema_version`,
  the fixture protocol above.

`run.mjs` emits all three explicitly (`seller_adcp_version`,
`core_buyer_adcp_schema_version`, `fixture_adcp_schema_version`) and retains
`adcp_schema_version` as the historical Python-pin field. Never apply the Python
pin to the TypeScript seller, and never relabel `pins.json` to make a version
mismatch go away — that would assert a verification of the Python artifact that
nobody performed.
