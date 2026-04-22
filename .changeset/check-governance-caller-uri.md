---
'@adcp/client': patch
---

Fix storyboard request-builder fallback shapes: every fallback now
satisfies the upstream JSON schema it pairs with, unblocking strict-mode
agents that reject non-conforming payloads at the MCP boundary.

**Builder fixes** (all only take effect when `step.sample_request` is
absent — authored fixtures are unaffected):

- `check_governance` — `caller` now emits `https://${brand.domain}`
  instead of a bare domain. Schema declares `caller: format: uri`. (#805)
- `build_creative`, `preview_creative`, `sync_creatives` — the
  `format_id` placeholder for a missing format now carries a
  URI-formatted `agent_url` (`https://unknown.example.com/`) instead of
  the string `"unknown"`. Schema (`core/format-id.json`) declares
  `agent_url: format: uri`.
- `update_media_buy` — fallback now injects
  `account: context.account ?? resolveAccount(options)`; schema lists
  `account` as required. Matches the pattern peer builders
  (`sync_creatives`, `sync_catalogs`, `report_usage`) already use.
- `get_signals` — when neither `options.brief` nor
  `sample_request.signal_ids` is present, fallback now emits
  `{ signal_spec: 'E2E fallback signal discovery' }` instead of `{}`.
  Schema `anyOf: [signal_spec | signal_ids]`.
- `create_content_standards` — fallback now emits a minimal inline
  bespoke policy (`policies: [{policy_id, enforcement: 'must', policy}]`)
  alongside `scope`. Schema `anyOf: [policies | registry_policy_ids]`.

**New test**: `test/lib/request-builder-jsonschema-roundtrip.test.js` —
AJV round-trip invariant that validates every builder fallback against
the upstream JSON schema. Complements the existing Zod round-trip test
(`request-builder-schema-roundtrip.test.js`), which does not enforce
`format` keywords or strict `additionalProperties`. `KNOWN_NONCONFORMING`
allowlist is empty; self-pruning guard tests fire if a new fallback
regresses or an allowlisted task starts passing.

**Observable-behavior notes**:

- Callers importing `buildRequest` who asserted on `get_signals` returning
  `{}` will need to update — it now returns `{ signal_spec }`.
- `update_media_buy` fallback now carries an `account`. Storyboards
  relying on a seller resolving account from `media_buy_id` alone via the
  fallback will now send a canonical account; if the seller is strict
  about account consistency across lifecycle, this is the correct signal.
  No shipping first-party storyboards hit this path (all author
  `sample_request.account`).

Closes #805.
