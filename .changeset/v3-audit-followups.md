---
'@adcp/client': minor
---

v3 audit follow-ups — tightened per expert review:

**Build pipeline**
- `build:lib` now runs `sync-version` before `tsc` so `src/lib/version.ts` can't drift from `package.json` across changeset-driven bumps. `sync-version` now validates both version strings against `/^[0-9A-Za-z.\-+]+$/` to prevent template injection into the generated TS file.

**sync_creatives validator**
- New `SyncCreativesItemSchema`, `SyncCreativesSuccessStrictSchema`, and `SyncCreativesResponseStrictSchema` exports. The strict schema enforces: required `creative_id` + `action`; spec's conditional that `status` MUST be absent when `action ∈ {failed, deleted}`; `preview_url` limited to `http(s):` URLs; ISO-8601 `expires_at`; `assignment_errors` key regex. Wired into `TOOL_RESPONSE_SCHEMAS` so pipeline-level strict validation catches per-item drift for `sync_creatives` responses automatically.

**V3 guard**
- New `VersionUnsupportedError` with typed `reason` ('version' | 'idempotency' | 'synthetic'). Agent URL stays on the instance property but is omitted from the default message to prevent leakage into shared log sinks.
- `client.requireV3()` now corroborates the v3 claim: requires `majorVersions.includes(3)`, `adcp.idempotency.replayTtlSeconds` present, and rejects synthetic capabilities. Closes the "lying seller" bypass path.
- New `allowV2` config option on `SingleAgentClientConfig` — per-client bypass; `ADCP_ALLOW_V2=1` env fallback only applies when `allowV2` is `undefined`. Enables safe use in multi-tenant deployments.
- `requireV3ForMutations: true` opt-in gates mutating calls before dispatch.
