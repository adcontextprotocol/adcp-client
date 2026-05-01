---
'@adcp/sdk': patch
---

`skills/call-adcp-agent/SKILL.md` and `docs/guides/BUILD-AN-AGENT.md` — callout block for the four spec-`correctable`-but-operator-human-escalate codes.

Surfaced during the recovery-classification audit closing #1136 and shipping in 6.3.0. Spec recovery is `correctable` for `POLICY_VIOLATION`, `COMPLIANCE_UNSATISFIED`, `GOVERNANCE_DENIED`, and `AUTH_REQUIRED`, but the operator semantic is human-in-loop:

- `POLICY_VIOLATION` / `COMPLIANCE_UNSATISFIED` / `GOVERNANCE_DENIED` are commercial-relationship signals. Auto-mutating creative, targeting, or budget and resubmitting looks like evasion to a seller's governance reviewer. Naive LLM agent loops that read `error.recovery === 'correctable'` and retry-with-tweaks will produce bad outcomes (and potentially get the buyer flagged).
- `AUTH_REQUIRED` conflates missing creds (genuinely correctable — re-handshake) with revoked / expired creds (operator must rotate). Until [adcontextprotocol/adcp#3730](https://github.com/adcontextprotocol/adcp/issues/3730) splits this into `auth_missing` + `auth_invalid`, treat as escalate-after-one-attempt to avoid retry storms on revoked keys.

The skill now teaches: spec recovery is `correctable`, operator behavior is human-in-loop. Read `error.message` + `error.suggestion`, surface to the user, don't loop.

Closes #1153. Companion to #1152 (the future `BuyerRetryPolicy` helper which will operationalize these defaults in code rather than docs).

Skills are bundled with the npm package (`files: ["skills/**/*"]`), so this is a publishable change.
