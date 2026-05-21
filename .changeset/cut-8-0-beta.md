---
'@adcp/sdk': major
---

feat!: cut 8.0-beta line — flip primary `ADCP_VERSION` pin to `3.1.0-beta.2`

The SDK's primary AdCP pin moves from `3.0.12` to `3.1.0-beta.2`. Pre-mode is entered with tag `beta`; subsequent changesets accumulate until upstream AdCP 3.1 goes GA and we `changeset pre exit`. Releases publish as `8.0.0-beta.N` under the `@beta` npm dist-tag.

Per [v8.0-beta plan](https://github.com/adcontextprotocol/adcp-client/blob/main/docs/development/v8.0-beta-plan.md):

**Wire compat retained** — `COMPATIBLE_ADCP_VERSIONS` keeps every `3.0.x` GA through `3.0.12` enumerated. An 8.0-beta SDK still talks to a 3.0-pinned seller because the wire is open per spec.

**Overlay emptied** — `FORWARD_COMPAT_ERROR_CODES` no longer needs `AUTH_MISSING`, `AUTH_INVALID`, `AGENT_SUSPENDED`, `AGENT_BLOCKED`; all four codes are now in the primary manifest-driven `ErrorCodeValues`. The compile-time disjointness check would fail if a code returned to the overlay after manifest adoption.

**Prerelease pin support added to `scripts/sync-version.ts`** — `3.1.0-beta.x` pins now build a `COMPATIBLE_ADCP_VERSIONS` enumeration that retains 3.0.x compat through the configured `LAST_3_0_GA_PATCH`.

**Breaking changes** — adopters moving to `8.0.0-beta.N` get the 3.1 typed surface across all schemas (`format_options`, `capability_ids`, `OutcomeMeasurement` reshape, asset shape changes, etc.). Migration story tracked in subsequent `needs:adcp-3.1` PRs.

**Spec changes folded in this cut:**

- AdCP 3.1.0-beta.2 schemas (catalog-sync cluster, V2 projection, write-side helpers, `capability_ids[]` on `PackageRequest`)
- Mock-server normative anchor

**Open follow-ups (separate PRs):**

- Envelope `status` REQUIRED on auto-registered `get_adcp_capabilities` handler (adcp release-note explicitly calls SDK out as the gap)
- `OutcomeMeasurement` type-import migration
- Brand `categories` field shape migration
- `AssetVariant` union handling
- `creative-asset` `format_id`/`manifest` shape migration
- Auto-derive `list_accounts`/`sync_accounts` from `AccountStore` (#1887 hinted)
- Drop legacy `mirror.adcontextprotocol.org` from `DEFAULT_MIRROR_HOSTS`

Closes the foundation work in #1580 (umbrella `needs:adcp-3.1`).
