---
"@adcp/sdk": patch
---

fix(conformance): strip compat-injected envelope status from unwrapped response data

`unwrapProtocolResponse` injected a synthetic `status: "completed"` field (via
the 3.0.x back-compat shim) into the Zod-validated data object that was returned
to callers. Because the Zod schemas use `.passthrough()`, the injected field
survived validation and appeared in `taskResult.data`, causing storyboard
`field_value_or_absent` checks on the deprecated legacy `status` field to fail
with a false positive — the runner observed the injected `"completed"` instead of
the seller's actual absent field.

The fix strips the injected `status` from the returned data when the seller's
original payload did not include it. The validation leniency itself is unchanged:
the shim still injects during `safeParse` so 3.0.x responses satisfy the 3.1
envelope schema. The fix applies to both the main success path and the
`filterInvalidProducts` early-return path.

Fixes #1961.
