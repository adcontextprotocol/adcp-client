---
'@adcp/sdk': patch
---

fix(server): default `account.supported_billing` to `['agent']` in `createAdcpServerFromPlatform`

When the v6 framework emits the `account` block in `get_adcp_capabilities` (because the platform declares `requireOperatorAuth: true` or `accounts.resolution: 'explicit'`), the schema requires `account.supported_billing` to be present with `minItems: 1`. The framework was spreading the field conditionally (`...(supportedBillings?.length && { supported_billing: [...] })`), which dropped the field entirely when adopters didn't declare `supportedBillings`. The capabilities response then failed schema validation.

Worse, downstream tooling (storyboard runner) auto-downgrades agents to "v2 synthetic capabilities" when capabilities probe fails, which cascades into every subsequent step erroring with "AdCP schema data for version v2.5 not found." One missing field collapsed entire storyboard runs.

Fix: when emitting the `account` block, always include `supported_billing`, defaulting to `['agent']` when adopters don't declare. `'agent'` (agent consolidates billing) matches the platform-interface contract documented at `src/lib/server/decisioning/capabilities.ts:130` ("Defaults to `['agent']` when omitted") and is the least-surprising default for non-media-buy specialisms (signals/creative/governance/etc.).

Surfaced empirically by the matrix v2 mock-server run on adcontextprotocol/adcp-client#1185. Closes adcontextprotocol/adcp-client#1186.

Adopters declaring `supportedBillings: ['operator', 'agent']` (or any non-empty subset) are unaffected — the projection still flows their declared values. Only adopters who omitted the field were exposed to the schema-validation regression; those will now pass with the spec-correct `['agent']` default.

Related upstream issue: adcontextprotocol/adcp#3746 (make `supported_billing` conditional on `supported_protocols.includes('media_buy')` at the schema level — the principled fix). This SDK change is the defensive default until the spec change lands.
