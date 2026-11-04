---
'@adcp/sdk': patch
---

fix(testing): keep the resolved account identity on account-subject storyboard requests

`applyBrandInvariant` merged the run's buying brand into every natural-key `request.account`. A
natural-key `AccountReference` is a composite identity (`core/account-ref.json` requires `brand`
AND `operator`), so replacing half of it re-addresses the request instead of re-scoping it. A run
with `brand: acmeoutdoor.example` that provisioned `{brand: test.example, operator: test.example,
sandbox: true}` through `sync_accounts` then read it back as `{brand: acmeoutdoor.example,
operator: test.example}` — schema-valid, and nobody's account. Correct sellers answered
`accounts: []` / `total_count: 0`, and account-aware test controllers refused the
`force_account_status` transition because the scope did not own `params.account_id`.

`list_accounts.account` is specified as an "exact account filter", and a `force_account_status`
scope has to be the account whose state machine it drives. On those requests `account.brand` is
now add-only: a brand that is already there survives verbatim (including `brand_id` and any other
nested brand metadata), a missing `operator` defaults from that preserved brand rather than the run
brand, and a malformed brand is left for the seller to refuse rather than silently substituted.

Nothing else changes: the cross-step run-brand invariant for buying and resource tools,
synthetic default accounts, unfiltered `list_accounts` enumeration, `omit_account` negative paths,
the closed `{account_id}` arm and the `request_account` brand-subject exemption all behave exactly
as before. `ACCOUNT_SUBJECT_TASKS` and `ACCOUNT_SUBJECT_CONTROLLER_SCENARIOS` are exported from the
storyboard runner so adopters can see what the exception covers.
