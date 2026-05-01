---
'@adcp/sdk': patch
---

Two bugs that silently broke every v3 buyer calling a v2.5 seller, surfaced by smoke-testing against the live Wonderstruck v2.5 sales agent.

**1. `brand_manifest` → `brand` aliasing dropped a string into an object slot.** `SingleAgentClient`'s field-stripping path renamed `brand_manifest` (URL string from the v2 adapter) back to `brand` whenever the agent's tool schema declared `brand` — without checking the destination's declared type. v2.5 sellers declare `brand` as a `BrandReference` object (`anyOf [object_with_required_domain, null]`). The string landed in the object slot and Wonderstruck rejected with `Input should be a valid dictionary or instance of BrandReference [type=model_type, input_value='https://wonderstruck.fm', input_type=str]`.

The fix adds a `valueMatchesSchemaType` helper that introspects the destination's declared shape (recursing into `anyOf` / `oneOf`) and only applies the alias when the value's runtime type is compatible. Legacy v2 sellers that declared `brand` as `type: 'string'` still get the URL routed correctly; v2.5 sellers with object-typed `brand` slots get the v3 brand object passed through unchanged (or stripped, depending on the rest of the schema).

**2. Response validation pinned to v3 even when targeting v2 sellers.** `TaskExecutor.validateResponseSchema` always passed `this.config.adcpVersion` (the SDK-pinned v3) to `validateIncomingResponse`. v2.5 sellers correctly returned v2.5-shaped responses; the SDK falsely rejected them as malformed v3 with errors like `pricing_options must NOT have fewer than 1 items` and `reporting_capabilities required`. The seller wasn't broken — the SDK was validating against the wrong schema.

The fix derives the validation version from `lastKnownServerVersion`: when the agent is v2-detected, validate against `'v2.5'`; otherwise the SDK-pinned default. Symmetric to the post-adapter request pass added in #1121.

Together these unblock real-world traffic to v2.5 sellers. Without them, every v3 buyer using `getProducts` against a v2.5 agent failed at one of the two points: the request was rejected (bug 1), or the response was reported as malformed (bug 2). Drift between v2.5 spec and seller behavior still surfaces via `result.debug_logs` (per #1133), so adopters can see real seller deviations without the SDK conflating them with version-mismatch artifacts.

Surfaced by `scripts/smoke-wonderstruck-v2-5.ts`. Five additional issues filed for follow-up: capability-detection against v2.5 returning a non-v3 shape (#23 in tracker), `supported_macros` `oneOf` cascade in `list_creative_formats` (#24), `list_authorized_properties` undefined-return (#25).
