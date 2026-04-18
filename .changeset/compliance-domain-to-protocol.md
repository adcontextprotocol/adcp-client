---
'@adcp/client': minor
---

Follow upstream AdCP rename of `domain` → `protocol` through the compliance cache, generated types, and storyboard runner.

**Compliance cache layout**

- `compliance/cache/{version}/domains/` → `compliance/cache/{version}/protocols/` (upstream currently ships both during transition; the runner now reads `protocols/`).
- `index.json` field `domains` → `protocols`.
- Specialism entries expose `protocol` (parent) instead of `domain`.

**Public API**

- `PROTOCOL_TO_DOMAIN` → `PROTOCOL_TO_PATH`.
- `PROTOCOLS_WITHOUT_BASELINE` removed. Upstream no longer lists `compliance_testing` under `supported_protocols`; it's declared via the top-level `compliance_testing` capability block. Agents still shipping the old enum value are handled silently inside `resolveStoryboardsForCapabilities`. If you imported `PROTOCOLS_WITHOUT_BASELINE`, delete the reference.
- `ComplianceIndexDomain` → `ComplianceIndexProtocol`.
- `BundleKind` value `'domain'` → `'protocol'`.
- `ComplianceIndex.domains` → `ComplianceIndex.protocols`.

**Generated types (from upstream schemas)**

- `AdCPDomain` → `AdCPProtocol`.
- `TasksGetResponse.domain` → `protocol`; `TasksListRequest.filters.{domain,domains}` → `{protocol,protocols}`; `MCPWebhookPayload.domain` → `protocol`.
- `GetAdCPCapabilitiesResponse.supported_protocols` no longer includes `'compliance_testing'`; presence of the top-level `compliance_testing` block declares the capability and `scenarios` is required within it.

**Security baseline storyboard (partial support)**

Upstream added a universal `security_baseline` storyboard whose steps target runner-internal tasks (`protected_resource_metadata`, `oauth_auth_server_metadata`, `assert_contribution`) and `$test_kit.*` substitution placeholders. The runner does not yet implement those execution paths. Steps targeting them are skipped with `skip_reason: 'missing_test_harness'` (overall storyboard reports `overall_passed: false` with zero passed steps). Full implementation — well-known metadata fetches, SSRF guardrails, accumulated-flag assertions, test-kit substitution — is tracked as a follow-up.

**Other**

- `adcp storyboard list` groups now labelled "Protocols" instead of "Domains".
- `docs/llms.txt` Flow summaries omit runner-internal tasks so LLM consumers don't mistake them for tools agents must expose.
