---
"@adcp/sdk": minor
---

feat(server): runtime validation for specialism→required-tools coverage

Stage 3 of #1192 (manifest adoption). When an adopter declares a specialism in `capabilities.specialisms[]`, the AdCP spec implies the agent supports every tool in that specialism's required-tool list (`SPECIALISM_REQUIRED_TOOLS` derived from manifest). This change adds a construction-time check in `createAdcpServerFromPlatform` that walks the platform object and warns (or throws under strict mode) when a required method is missing.

What lands:

- `src/lib/server/decisioning/validate-specialisms.ts` — `validateSpecialismRequiredTools(platform, specialisms)` and `formatSpecialismIssue(issue)` helpers. Walks every top-level field on the platform and checks for a function-typed property matching `snakeToCamelCase(tool)`. "Method-presence-anywhere" rather than "method-on-specific-field" because required tools span platform fields (`sync_accounts` lives on `accounts`, not on the specialism's primary `sales`) and pinning ownership upfront would either need a per-tool field map or false-positive on legitimate alternative layouts.

- `createAdcpServerFromPlatform`: after `validatePlatform`, runs the specialism check. Default behavior is `console.warn` for each missing method (with specialism + tool + method name). New `strictSpecialismValidation: true` opt opts into `PlatformConfigError` on missing methods — recommended for production CI builds.

- `scripts/generate-manifest-derived.ts`: now populates `SPECIALISM_REQUIRED_TOOLS` via reverse-mapping from `manifest.tools[*].specialisms[]` (the manifest's direct `specialisms[*].required_tools` is empty in 3.0.4). Filters universal tools (`get_adcp_capabilities` and other `protocol`-protocol tools) and normalizes specialism keys to kebab-case to match the spec's `AdCPSpecialism` enum.

What's deferred (was originally option C of #1299):

The build-time type fixture asserting `RequiredPlatformsFor<S>` collectively exposes every required tool method was scoped out after implementation revealed too many false-positives from cross-cutting tools (e.g., `sync_accounts` is required by `sales-non-guaranteed` but lives on `AccountsPlatform`, not `RequiredPlatformsFor<'sales-non-guaranteed'> = { sales: SalesPlatform }`). Rescoping this to a "platform-interface family collectively covers every required-tool method" assertion (without per-specialism mapping) is tracked as a follow-up on #1299.

Closes #1299 (option B portion).
