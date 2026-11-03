---
"@adcp/sdk": major
---

Breaking: default MCP controller registration (`registerTestController`,
`createComplyController().register`, and wrappers spreading `TOOL_INPUT_SHAPE`)
now requires `account: { sandbox: true, ...identity }`, matching AdCP 3.1 and later.
The account object preserves complete natural identity or an opaque account ID
through MCP parsing, so per-request store factories can resolve the seed scope.

All callers, including `list_scenarios` probes and AdCP 3.0 callers that previously
omitted the account, must add the sandbox assertion. The assertion is caller
intent; adopters must still authorize against persisted sandbox account state.
The SDK reporting doctor now sends it on its own scenario probe. This change
belongs to SDK 17 and must not be backported unchanged to the stable SDK 16 line.

The platform controller wrapper retains its existing optional-account compatibility
shape and trusted principal/target authorization gates, while accepting operator
unit, currency, and timezone. Public opaque AccountRefs remain `{ account_id }`;
only the controller carrier adds `sandbox: true`.
