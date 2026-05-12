---
'@adcp/sdk': patch
---

fix(version): auto-derive COMPATIBLE_ADCP_VERSIONS from ADCP_VERSION pin

The 3.0.x patch enumeration in `COMPATIBLE_ADCP_VERSIONS` was a hardcoded
array literal inside the `scripts/sync-version.ts` template. Every AdCP
patch bump needed someone to remember to append the new version to it.
The 3.0.9, 3.0.10, and 3.0.11 chore PRs all forgot — the list capped
at `3.0.8` even though `ADCP_VERSION` moved to `3.0.11`. Symptom:
`isCompatibleWith('3.0.11') === false` against the SDK's own pin.

Same root-cause class as the schema URL pinning drift surfaced by
`adcontextprotocol/adcp#4419` (BidMachine reports / "3.0.1 schemas" cited
against a 3.0.11 seller): a load-bearing version surface that depends on
human discipline at every patch bump.

Fix:

- `scripts/sync-version.ts` now derives the list dynamically from the
  current `ADCP_VERSION`. Enumerates `3.0.0..3.0.<patch>` mechanically;
  the bumper no longer has to remember anything.
- Fails closed when `ADCP_VERSION` falls outside the `3.0.x` range so a
  future 3.1.x or 4.x bump forces the script to be extended (rather than
  silently inheriting a stale enumeration). The compat surface for a
  major/minor move is rarely mechanical — that's the right time to think.
- Adds `test/lib/compatible-versions-self-consistency.test.js` asserting
  the regenerated list contains the current pin and fills the
  `3.0.0..ADCP_VERSION` range without gaps. Future regressions (someone
  reverting to hardcoded literals) fail loud at CI.

Does not address the deeper schema URL pinning drift in
`src/lib/testing/storyboard/validations.ts` (SDK-build-time `ADCP_VERSION`
used in cited schema URLs regardless of the agent's advertised version);
tracked separately at adcp-client#NNNN.
