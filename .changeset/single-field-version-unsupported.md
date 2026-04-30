---
'@adcp/sdk': patch
---

fix(server): extend VERSION_UNSUPPORTED check to single-field version claims (#1075)

`createAdcpServer`'s version check previously fired only when both `adcp_version` and `adcp_major_version` were present with disagreeing majors (the dual-field drift guard). A buyer sending only `adcp_major_version: 99` or only `adcp_version: "99.0"` against a 3.0-pinned seller would bypass the check entirely — the unsupported integer reached the handler unvalidated.

This patch adds the missing boundary enforcement: after the dual-field disagreement check, the handler now computes the effective claimed major from whichever version field(s) are present and rejects it with `VERSION_UNSUPPORTED` if it is not in the seller's advertised `major_versions`. The error includes `details.supported_versions` (e.g. `["3.0"]`) so buyers can negotiate a downgrade, and `details.requested_version` when an `adcp_version` string was supplied.

Spec MUST per `tools.generated.ts:253`: sellers MUST validate against their supported `major_versions` and return `VERSION_UNSUPPORTED` if unsupported.

No security impact — the schema bundle is server-pinned and the buyer's version claim does not affect dispatch. This is a spec-conformance improvement that closes a wire-level invariant gap surfaced in the security review of PR #1073.
