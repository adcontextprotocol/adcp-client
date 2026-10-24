---
'@adcp/sdk': patch
---

Adopt the signed AdCP 3.2.6 schema and compliance bundles, refresh canonical storyboard provenance, and retain the unchanged reviewed commercial-terms contract while preserving AdCP 3.1 and 3.0 compatibility.

Resolve property and collection lists from standard MCP structured or JSON text responses, preserving upstream AdCP errors. Keep task completion separate from media-buy lifecycle observations in storyboard checks. Stop injecting task status into current, unversioned, and status-free compact responses during conformance validation, while retaining explicitly declared AdCP 3.0 compatibility. Admit canonical version metadata in closed response schemas without relaxing other fields.

Prepare build tooling for exact AdCP 3.3 beta and release-candidate pins without advertising 3.3 support from stable SDK 16.

When grading AdCP 3.0 sellers, select the matching AdCP 3.0 schema version so their status-optional responses are evaluated against that release.
