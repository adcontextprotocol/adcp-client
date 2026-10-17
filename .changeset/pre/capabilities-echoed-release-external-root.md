---
'@adcp/sdk': patch
---

Validate `get_adcp_capabilities` against the release the agent echoed even when an external schema root is active for the pin (#3320). Hosted compliance always runs with one, so a 3.0 target graded a conformant 3.2 capabilities response against 3.0: every storyboard `response_schema` check on that task failed, and discovery raised spurious `capabilities_response_schema_invalid` notices.

The storyboard `response_schema` check, discovery's capability validation and `getAdcpCapabilities()` now use the echoed `adcp_version` when it is the pin's major, is listed in the response's own `adcp.supported_versions`, and has a schema root: one supplied for that release, an external root registered for it, or the SDK's bundled schemas. Otherwise they validate strictly against the pin. Requiring the `supported_versions` listing is new. Other tasks, storyboard selection, the run's `adcp_version` and grading stay on the pin.

New `servedReleaseSchemaRoots` option on `comply()`, `runStoryboard()` and `runStoryboardStep()`: a map of AdCP version to schema root (same shape as `schemaRoot`) for releases an agent may echo. Those roots are used only for this capabilities validation. `withServedReleaseSchemaRoots(roots, fn)` from `@adcp/sdk/testing` scopes the same map for other callers.
