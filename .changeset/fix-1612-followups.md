---
"@adcp/sdk": patch
---

chore(comply): #1612 review follow-ups

Three small follow-ups from the expert reviews of #1613:

1. **CLI `--protocol` / `--transport` parse-site 3** (`bin/adcp.js`) now
   matches the trailing-flag-validation pattern at the other two parse
   sites — a trailing `--transport` no longer slips past the truthiness
   gate as `protocolFlag === undefined`. Pre-existing parity bug,
   surfaced by the parallel review of #1613.

2. **`raceWithSignal`** (`src/lib/testing/client.ts`) gains a security
   warning in its JSDoc and an inline comment on the orphan-promise
   resolver: do not log `v` from inside that branch, since the orphaned
   promise still carries an authenticated agent response after the buyer
   has moved past the abort. Behavior unchanged; commentary only.

3. **Test coverage** for the second `getAdcpCapabilities` call in
   `discoverAgentProfile`. The existing tests covered abort during the
   first `getAgentInfo` call only; the new test exercises an abort
   firing while the second `raceWithSignal`-wrapped call is in flight,
   asserts that `capabilities_probe_error` records the abort reason,
   and bounds the wait. Closes the coverage gap surfaced by the
   `code-reviewer` review of #1613.

Two larger follow-ups from the same review round are tracked separately:
- `tasks/cancel` integration so comply abort doesn't orphan billed
  seller work — adcp-client#1617.
- SSRF denylist on `detectProtocol` / `discoverAgentProfile` for the
  future server-side comply runner — adcp-client#1618.
