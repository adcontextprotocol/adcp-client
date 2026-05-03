---
name: build-brand-rights-agent
description: Use when building an AdCP brand rights agent — a platform that represents brand identity, licenses rights (image usage, logo placement, AI generation), and approves creatives.
---

# Build a Brand Rights Agent

A brand rights agent represents a brand's identity and licensing. Buyers discover the brand, browse available rights (image usage, logo placement, AI generation), acquire licenses, and submit generated creatives for approval. The agent enforces brand guidelines.

## Pick your fork target

| Specialism | Status | Fork pattern | Storyboard |
| --- | --- | --- | --- |
| `brand-rights` | stable | Seller-adapter wiring + `brandRights` domain group + `creative_approval` webhook receiver | `brand_rights` |

A worked brand-rights fork target is tracked as a follow-up. Until then, use [`hello_seller_adapter_guaranteed.ts`](../../examples/hello_seller_adapter_guaranteed.ts) as the wiring reference (`createAdcpServerFromPlatform`, `serve`, idempotency store) and add the `brandRights` domain group via `defineBrandRightsPlatform` from `@adcp/sdk/server`.

The storyboard tests identity discovery → rights search → acquisition → enforcement (including expired-campaign denial).

For exact response shapes, error codes, and optional fields, `docs/llms.txt` is the canonical reference.

## When to use this skill

- User wants to build an agent that manages brand identity and licensing
- User mentions brand rights, brand guidelines, creative approval, or licensing (Warner Bros Discovery, Disney rights pipelines)
- User references `get_brand_identity`, `get_rights`, `acquire_rights`, `update_rights`, or `creative_approval`

**Not this skill:**

- Selling ad inventory → `skills/build-seller-agent/`
- Managing creative formats/library → `skills/build-creative-agent/`
- Evaluating media buys → `skills/build-governance-agent/`

## Cross-cutting rules

Every brand-rights agent hits the cross-cutting rules in [`../cross-cutting.md`](../cross-cutting.md). One brand-rights-specific note:

### `creative_approval` is webhook-only

The spec models creative approval as an HTTP POST from the buyer to the `approval_webhook` URL the seller returned in `acquire_rights`. There is no inbound MCP/A2A tool for `creative_approval` — wire an HTTP receiver and dispatch to `brandRights.reviewCreativeApproval`.

The receiver must validate `idempotency_key` itself (the framework's auto-idempotency middleware applies to MCP/A2A tools, not arbitrary HTTP receivers) and replay the cached verdict on resubmission.

## Tool surface

| Operation | How to implement |
| --- | --- |
| `get_brand_identity` | `brandRights.getBrandIdentity` handler — locale-keyed brand name, domain, logos, house identity |
| `get_rights` | `brandRights.getRights` handler — list licensable rights with pricing + use cases |
| `acquire_rights` | `brandRights.acquireRights` handler (mutating) — returns `approval_webhook` URL |
| `update_rights` | `brandRights.updateRights` handler (mutating) — for campaign-end revocation, scope changes |
| `creative_approval` | HTTP receiver at the `approval_webhook` URL; dispatch to `brandRights.reviewCreativeApproval` |

## Specialism deltas

**`brand-rights`** —

- **Brand definition**: name (locale-keyed for i18n), domain, logos, house identity, languages/markets
- **Rights catalog**: image usage, AI generation, logo placement, talent likeness; each with pricing (flat_rate, cpm) and uses (likeness, voice, commercial, ai_generated_image)
- **Approval criteria**: auto-approve (basic checks), guidelines check (brand standards), human review (queue for manual)
- **Revocation webhook**: emit when a campaign ends or rights are revoked mid-campaign — same `operation_id` stability rules as other webhooks (see `../cross-cutting.md`)
- **Governance denial**: the storyboard exercises `GOVERNANCE_DENIED` on `acquire_rights` when the requested use exceeds the licensed scope; map this error code, don't substitute a generic `INVALID_REQUEST`

## Validate locally

```bash
# Run your forked agent against the brand_rights storyboard
adcp storyboard run http://127.0.0.1:3009/mcp brand_rights \
  --bearer "$ADCP_AUTH_TOKEN" --include-bundles --json
```

The fork-matrix gate pattern from [`docs/guides/EXAMPLE-TEST-CONTRACT.md`](../../docs/guides/EXAMPLE-TEST-CONTRACT.md) (tsc strict / storyboard zero-failures / upstream façade) applies — when the worked brand-rights adapter lands, it'll plug into the same gate.

For deeper validation: [`docs/guides/VALIDATE-YOUR-AGENT.md`](../../docs/guides/VALIDATE-YOUR-AGENT.md).

## Common shape gotchas

`acquire_rights` response includes `approval_webhook` URL — buyer POSTs to this to submit creatives, you don't pull. `sync_accounts` rows require `action: 'created' | 'updated' | 'unchanged' | 'failed'`. Brand name is locale-keyed (`{ "en-US": "...", "es-MX": "..." }`), not a bare string. See [`../SHAPE-GOTCHAS.md`](../SHAPE-GOTCHAS.md).

## Migration notes

- 6.6 → 6.7: `update_rights` wired as a first-class tool + `creative_approval` webhook builders shipped in #1349. See [`docs/migration-6.6-to-6.7.md`](../../docs/migration-6.6-to-6.7.md).
- 4.x → 5.x: [`docs/migration-4.x-to-5.x.md`](../../docs/migration-4.x-to-5.x.md)
