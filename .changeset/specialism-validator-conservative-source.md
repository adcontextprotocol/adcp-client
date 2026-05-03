---
"@adcp/sdk": patch
---

fix(server): specialism validator uses authoritative manifest data only (no reverse-mapping)

Follow-up to #1306. The original `generate-manifest-derived.ts` reverse-mapped from `manifest.tools[*].specialisms[]` when the spec's direct `manifest.specialisms[id].required_tools` was empty. That triggered false warnings on legitimate adopters: the `hello_signals_adapter_marketplace` example (a pure signal-marketplace seller exposing only `get_signals` / `activate_signal`) emitted three "missing method" warnings for `sync_accounts` / `sync_governance` / `sync_plans` — tools associated with the `signal_marketplace` specialism in the manifest's tool→specialism mapping but not actually required to claim the specialism.

The semantic distinction matters: `manifest.tools[*].specialisms[]` captures "tool associated with specialism" (e.g., the spec mentions sync_accounts in signal-marketplace context), while `manifest.specialisms[*].required_tools` captures "tool required to claim specialism." Reverse-mapping conflated the two.

Changes:

- `scripts/generate-manifest-derived.ts`: drop reverse-mapping. `SPECIALISM_REQUIRED_TOOLS` is now sourced ONLY from `manifest.specialisms[*].required_tools` (authoritative spec field). 3.0.4 ships every specialism with `required_tools: []`, so the table is empty — the validator becomes a no-op until the spec authors populate authoritative lists in a future release.

- `src/lib/server/decisioning/validate-specialisms.ts`: add an optional `requiredToolsLookup` parameter to `validateSpecialismRequiredTools` so tests can inject synthetic data without depending on manifest state. Production callers omit it and get the manifest-derived (currently empty) lookup.

- `test/lib/validate-specialisms.test.js`: tests now use a `SYNTHETIC_REQUIREMENTS` map injected via the new parameter, so coverage isn't tied to whether the manifest happens to have populated `required_tools` for any specialism. Added a sanity test asserting the default lookup is no-op in 3.0.4 — when the spec populates the field, that test will fail and prompt a refresh.

- `CLAUDE.md`: add the `governance-aware-seller` specialism row that was missing from the table (flagged in #1306 review).

This finalizes #1192's stage 3 infrastructure. The runtime check is wired through `createAdcpServerFromPlatform`; the data source is conservative (only fires on what the spec authoritatively says is required); the activation path is automatic on next manifest sync after the spec populates `required_tools`. Closes the manifest-adoption umbrella issue #1192.
