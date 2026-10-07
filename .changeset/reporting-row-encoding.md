---
'@adcp/sdk': minor
---

Add the canonical JSONL row encoding for reporting revisions to `@adcp/sdk/reporting/ledger`: contract-fixed 500-row segments and 10,000-row / 8 MiB chunks, segment and chunk digests, a row-manifest digest for the revision header, ranged verified segment decoding, and streaming hashers that reproduce the protocol `revision_content_sha256` (and the `rows_v1` profile) from stored chunk bytes without parsing rows. Writers refuse rows that are not portable across RFC 8785 implementations (unsafe integers, non-finite numbers, lone surrogates, non-plain objects). This is the first building block of pluggable revision row storage; no existing store behavior changes.
