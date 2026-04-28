# @adcp/client

## 6.0.0

### Minor Changes

- 9de471e: feat: add `adcpVersion` constructor option on client + server surfaces

  `SingleAgentClient`, `AgentClient`, `ADCPMultiAgentClient`, and `createAdcpServer` now accept an `adcpVersion?: string` option that surfaces via a new `getAdcpVersion()` instance method. Defaults to the SDK's pinned `ADCP_VERSION` (currently `'3.0.0'`) when omitted. Pin to an older stable (`'3.0.0'`) or opt into a beta channel (`'3.1.0-beta.1'`) once the corresponding registry ships.

  Plumbing surface only — Stage 2 of the multi-version refactor. The configured value is exposed and propagated, but validators and schema selection still key off the global `ADCP_VERSION` constant. Stage 3 wires per-instance schema loading off this getter so cross-version testing (a 3.0 client speaking to a 3.1 server in the same process) works without npm aliases.

  `AdcpServerConfig.adcpVersion` is independent of `AdcpServerConfig.version`; the latter is the publisher's app version, the former is the AdCP protocol version on the wire.

- 9de471e: feat: rename `@adcp/client` to `@adcp/sdk` + add `/client` and `/compliance` subpath umbrellas

  The library is now published as `@adcp/sdk` to reflect the three surfaces it ships — buyer-side client, server builder, and compliance harness. `@adcp/client` continues to publish from `packages/client-shim/` as a thin re-export of `@adcp/sdk` (including a CLI delegator so `npx @adcp/client@latest …` keeps working), so existing installs keep functioning without code changes. Replace `@adcp/client` with `@adcp/sdk` in your imports when convenient — APIs are identical.

  New subpath exports group the surfaces so `@adcp/sdk/client`, `@adcp/sdk/server`, and `@adcp/sdk/compliance` resolve to the right slice for each use case. The root export (`@adcp/sdk`) continues to re-export the client surface verbatim, so `import { AdcpClient } from '@adcp/sdk'` and `import { AdcpClient } from '@adcp/sdk/client'` are equivalent. The new `@adcp/sdk/compliance` umbrella re-exports `testing` + `conformance` + `compliance-fixtures` + `signing/testing` for compliance harnesses that want one import path; the individual subpaths still resolve directly so callers who only need fuzzing don't pay the bundle cost of test agents.

  Repo restructure: top-level `package.json` now declares an npm workspace covering `.` plus `packages/*`. The two packages stay version-linked via `.changeset/config.json` so they always release at the same number; the shim's `dependencies."@adcp/sdk"` bumps automatically with each release.

### Patch Changes

- 5fb6729: fix(testing): signals governance advisory block now fires correctly

  The governance advisory check in `testSignalsFlow` was silently a no-op: it
  re-parsed `signalsStep.response_preview` (a pre-formatted summary string) looking
  for `.signals`/`.all_signals` keys that never exist in that format, so
  `withRestrictedAttrs` and `withPolicyCategories` were always empty arrays.

  `discoverSignals` now returns the raw `GetSignalsResponse.signals` array alongside
  the digested `AgentProfile.supported_signals` array. The advisory block uses the
  raw array directly and also evaluates signals discovered via the fallback-brief
  loop, so agents whose first `get_signals` call returns empty are still graded.
  The advisory hint now points operators at the spec-correct surface for declaring
  `restricted_attributes`/`policy_categories` (the `signal_catalog` in
  `adagents.json`).

- Updated dependencies [14623ee]
- Updated dependencies [9de471e]
- Updated dependencies [71df387]
- Updated dependencies [36d3c81]
- Updated dependencies [9de471e]
  - @adcp/sdk@6.0.0
