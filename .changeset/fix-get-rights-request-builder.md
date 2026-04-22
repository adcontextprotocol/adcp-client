---
'@adcp/client': patch
---

Storyboard runner: honor `step.sample_request` in `get_rights`
request builder.

Prior behavior hardcoded `query: 'available rights for advertising'`
and `uses: ['ai_generated_image']`, and injected `brand_id` from the
caller's `brand.domain`. Storyboards declaring scenario-specific
query text, uses, or a `buyer_brand` hit the wire with the generic
fallback instead, and rights-holder rosters rejected the
caller-domain `brand_id` as unknown — so `rights[0]` was undefined,
`$context.rights_id` didn't resolve, and downstream `acquire_rights`
steps failed with `rights_not_found` instead of the error the
storyboard was actually asserting (e.g., `GOVERNANCE_DENIED` in
`brand_rights/governance_denied`).

Mirrors the pattern used by peer builders (`sync_plans`,
`check_governance`, `list_creative_formats`,
`create_content_standards`, etc.). The generic fallback still runs
when no `sample_request` is authored.

Closes adcp#2846.
