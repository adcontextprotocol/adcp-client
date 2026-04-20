---
'@adcp/client': patch
---

Skill docs: specialism coverage tables, composition guide, AdCP 3.0 GA alignment.

Every `build-*-agent/SKILL.md` now maps specialism IDs to concrete per-specialism deltas, with archetype splits where the contracts diverge (creative: ad-server / template / generative). Root `CLAUDE.md` gets the inverse specialism → skill index.

Seller skill picks up:
- Protocol-Wide Requirements: `idempotency_key` via `createIdempotencyStore`, mandatory auth pointer, signature-header transparency.
- Composing OAuth + signing + idempotency: real `serve({ authenticate, preTransport })` wiring, `verifyBearer` from `@adcp/client/server`, low-level `verifyRequestSignature` (preTransport-shaped; not `createExpressVerifier` which is Express-shaped), `resolveIdempotencyPrincipal` threading from `ctx.authInfo.clientId` + multi-tenant composition.
- Per-specialism sections for `sales-guaranteed` (A2A task envelope for IO approval), `sales-non-guaranteed` (bid_price + update_media_buy), `sales-broadcast-tv`, `sales-social`, `sales-proposal-mode`, `audience-sync`, `signed-requests`.

Governance skill: Plan shape updated to `budget.reallocation_threshold` / `reallocation_unlimited` + `human_review_required` (no more `authority_level`), `content_standards.policies[]` as structured array with per-entry `enforcement`, `validate_content_delivery.artifact.assets` as array, `property-lists` / `collection-lists` (new) / `content-standards` specialism sections. Governance status enum is approved | denied | conditions — approved-with-conditions is `status: 'conditions'`, not an approved + conditions array.

Signals skill: async platform-activation pattern, value-type constraints, deployed_at.

Brand-rights skill: schema-accurate `logos[].background` (dark-bg/light-bg/transparent-bg), `tone.voice` nesting, `terms` with required pricing_option_id/amount/currency/uses, `rights_constraint` with required `rights_agent`, `approval_webhook` credentials minLength 32, `available_uses` using spec-valid enum values.

Retail-media skill: scope note (catalog-driven ≠ retail-only).

Validated via five rounds of fresh-builder tests against the skills + one end-to-end test with the storyboard runner. Median build confidence climbed from 3/5 (round 1) to 4-5/5 (round 5). End-to-end runs surfaced three upstream spec/runner bugs now tracked in adcontextprotocol/adcp#2418, adcontextprotocol/adcp#2420, and adcontextprotocol/adcp-client#625.
