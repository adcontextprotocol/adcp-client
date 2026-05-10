---
'@adcp/sdk': patch
---

chore: bump AdCP pin to 3.0.9

Pulls AdCP v3.0.9 into the schema cache and adds it to
`COMPATIBLE_ADCP_VERSIONS`. Patch bump because v3.0.9 is description-only:

- **adcp#4302** — propagates the existing `list_accounts` / `sync_accounts`
  account-discovery MUST from `required-tasks.mdx` into `accounts/overview.mdx`.
  Restates the existing requirement in the surface-level overview where
  implementors look first; no wire shape change. Filed against
  adcp-client#1624 (storyboard rubric for missing-account-tool fail) which
  is now unblocked at the spec level.
- HMAC-as-recommended framing fix in `reporting-webhook.json`,
  `auth-scheme.json`, and `create-media-buy-request.json`'s `artifact_webhook`;
  RFC 9421 default guidance added to `call-adcp-agent` SKILL.md. Description
  text only — generated `tools.generated.ts` / `core.generated.ts` reflect
  the updated docstrings.

Generated file diffs are limited to:
- `Source:` path bumps from `schemas/cache/3.0.8/` to `schemas/cache/3.0.9/`
  in `entity-hydration.generated.ts`, `wire-spec-fields.generated.ts`.
- Description-only updates to `core.generated.ts`, `manifest.generated.ts`,
  `tools.generated.ts` reflecting the legacy-auth deprecation framing fixes.

No behavior change. No test updates required (1600+ existing tests pass
unchanged against the 3.0.9 cache).

Unblocks adcp-client#1624 (the storyboard runner can now cite v3.0.9
normative language for the universal account-discovery requirement when
the runner.ts:936 fix lands).
