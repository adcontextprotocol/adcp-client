---
'@adcp/sdk': patch
---

Avoid multi-megabyte generated JSON Schema validator functions and the associated Node24/V8 Maglev memory spikes (#3457). Compile available authored modular tool graphs with separate referenced validators, retain response-envelope relaxation and bundled-only custom-root support, and factor large self-contained conformance schemas into private local definitions before compiling. Public schema documents and compact archive serialization remain unchanged. AJV construction sites now retain referenced validator functions instead of inlining them.

Together with cached compliance storyboard lookups, this also reduces the cold validation cost reported in #3455 without changing process-wide V8 settings.

Validation diagnostics retain AJV's original function-relative `schemaPath` spelling; private origin IDs stay internal. Runtime schema paths may change with compiler factoring and are diagnostic details, not stable selectors into the public bundled document. `schemaId` records the effective rejecting resource where available, including embedded IDs; unavailable origin metadata falls back conservatively to the compiled tool root. Required-field pointers escape slashes and tildes per RFC 6901.
