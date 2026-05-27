---
'@adcp/sdk': minor
---

Add `createCanonicalReferenceResolver` through the package root and `@adcp/sdk/canonical-references` for immutable `format_schema` and `platform_extensions` URI+SHA-256 references. The resolver applies SSRF-safe DNS-pinned fetching, redirect blocking, timeout and body caps, digest verification, caller-owned policy-scoped caching, structured non-throwing statuses, and JSON Schema validation plus pinned `$ref` sandboxing for `format_schema`.
