---
'@adcp/sdk': minor
---

Expose the standalone proposal commercial-terms verifier through `@adcp/sdk/negotiation/verification` with ESM/CJS types. Fail closed on unsupported schema keywords, cross-bundle references, and changed validation contracts throughout the commercial-terms schema graph. Preserve digest-first exhaustive comparison and legacy opaque contract-reference behavior, and document runtime schema coupling and upstream shim retirement.

Enforce schema-declared targeting disjointness, geographic label membership, language-tag grammar, and IANA timezone annotations before comparing terms, with validators isolated from ordinary SDK schema validation. Pin extensible-enum annotations while preserving explicit enum membership for binding snapshots.
