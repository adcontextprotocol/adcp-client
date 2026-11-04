---
'@adcp/sdk': patch
---

fix(testing): keep the resolved account identity on account-subject storyboard requests, and ship the published comply_test_controller schemas

**Account-subject identity.** `applyBrandInvariant` merged the run's buying brand into every
natural-key `request.account`. A natural-key `AccountReference` is a composite identity —
`core/account-ref.json`'s natural-key arm is `required: [brand, operator]`,
`additionalProperties: false`, in every supported release, and 3.2 widened it further with
`operator_unit` / `currency` / `timezone`. Replacing half of it re-addresses the request instead of
re-scoping it. A run with `brand: acmeoutdoor.example` that provisioned
`{brand: test.example, operator: test.example, sandbox: true}` through `sync_accounts` read it back
as `{brand: acmeoutdoor.example, operator: test.example}` — schema-valid, and nobody's account.
Correct sellers answered `accounts: []` / `total_count: 0`; account-aware test controllers refused
the `force_account_status` transition because the scope did not own `params.account_id`. Under
3.3.0-beta.3 it is worse than an empty read: a natural key resolves only when exactly one account
matches and returns `ACCOUNT_AMBIGUOUS` otherwise, so a substituted brand can resolve to a
different _real_ account.

On requests whose `account` names the account the request is _about_ — `list_accounts`,
`get_account_financials`, `list_account_changes`, and the `force_account_status` /
`expire_account_change_cursor` controller scenarios — `account.brand` is now add-only: a brand that
is already there survives verbatim (`brand_id` and any other nested brand metadata included), a
missing `operator` defaults from that preserved brand rather than the run brand, and a malformed
brand is left for the seller to refuse rather than silently substituted. A reference that carries
no brand still gets the run brand, because the natural-key arm requires one.

Everything else behaves exactly as before: the cross-step run-brand invariant for buying and
resource tools, synthetic default accounts, unfiltered `list_accounts` enumeration, `omit_account`
negative paths, the closed `{account_id}` arm, and the `request_account` brand-subject exemption.
`simulate_budget_spend` is deliberately left out — its `params` are
`anyOf: [{required: [account_id]}, {required: [media_buy_id]}]` and only the `account_id` arm is
account-subject. No new public API: the task and scenario sets stay internal to the policy module.

**Packaging.** Every supported release publishes
`compliance/comply-test-controller-{request,response}.json`, but the build excluded the whole
`compliance/` subtree, so on an installed package
`getSchemaValidatorByRef('compliance/comply-test-controller-request.json', '3.1.31')` returned
`undefined` — no caller could validate either direction of a tool the SDK tells them to drive. The
build now carries those two documents plus the sibling `compliance/` documents they `$ref`,
transitively, per selected version: 3.0.25 and 3.1.31 ship exactly the two entry points, while
3.2.8 and 3.3.0-beta.3 also ship `task-completion-data.json` and
`get-creative-features-completion.json`, without which AJV cannot compile the controller validator
at all. Files are copied byte-for-byte from the published cache; nothing else under `compliance/`
is packaged.

Two intended consequences: `getValidator` / `getSchemaValidatorByRef` now resolve for
`comply_test_controller` on every supported version, and `schemaAllowsTopLevelField` gates its
fields from the declared schema instead of failing open. The published request declares `account`
but no top-level `brand`, so the storyboard runner stops adding an undeclared, non-canonical
top-level `brand` to controller requests — that field was a schema-valid extension under
`additionalProperties: true`, never an invalid request, and `account` remains the declared identity
carrier.
