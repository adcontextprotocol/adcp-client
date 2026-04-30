---
"@adcp/sdk": minor
---

fix(server): extend VERSION_UNSUPPORTED to single-field version claims

`createAdcpServer` now rejects requests where `adcp_major_version` (integer) or `adcp_version` (string) is set to an unsupported major, not only when both fields are present and disagree.

**Behavior change for existing callers:** sellers running with the default `major_versions: [3]` will now return `VERSION_UNSUPPORTED` for requests carrying `adcp_major_version: 99` (or any unsupported integer), where before those requests dispatched silently. This closes the spec drift — the AdCP spec requires sellers to validate `major_versions` and return `VERSION_UNSUPPORTED` for unsupported claims. No legitimate production traffic sends unsupported major versions; conformance harnesses testing `VERSION_UNSUPPORTED` behavior are the primary callers of this path.

The `VERSION_UNSUPPORTED` error response now includes `details.supported_versions` (array of version strings derived from the server's `major_versions` config) and `details.requested_version` for both new checks. This unblocks the `error_compliance/unsupported_major_version` storyboard step once PR #1073 (caller-wins fix) and this fix are both merged.

Refs: #1075
