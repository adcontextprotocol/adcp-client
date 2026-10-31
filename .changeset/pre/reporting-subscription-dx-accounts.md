---
'@adcp/sdk': major
---

**Breaking (SDK 17, AdCP 3.3):** `client.accounts.ensure` now resolves to a discriminated `AccountOutcome` instead of the registry's `ProvisionedAccount`.

- **Outcomes.** `ensure` resolves to `ready | pending | ambiguous | rejected`, switched on `kind`. `pending` is a value, not an exception: it carries the seller's `action` (`PendingAction`: `waiting_on`, `kind`, `message`, `url?`, `expires_at?`) and the open `request_id`. `ambiguous` carries `candidates` and `choose(accountId)`. `rejected` carries the wire `errors`. Only a failure to process the call throws: `AccountRequestError` (new, with the wire `code` and `recovery`) on the `request_account` path, and the existing typed account errors on `sync_accounts`.
- **Capability routing.** When the seller advertises `account.requests`, `ensure` calls `request_account`; otherwise it calls `sync_accounts` as before. It is idempotent per (seller, caller, natural key): a repeat call returns the open request's state and never opens a duplicate, and registries that share storage send one deterministic idempotency key. `currency` and `timezone` options join the natural key. `AccountCapabilities.requestsSupported` is new.
- **`client.accounts.refresh()`** re-reads open requests and accounts pending approval, and resolves to the outcomes that moved. **`client.accounts.pending()`** lists what is still waiting, with no network call. `BuyerAccountStorage.list?(scope)` lets both see rows another process stored.
- **`nextStep(outcome)`** (`'wait_for_seller' | 'send_human_to_url' | 'pick_candidate' | 'contact_seller' | 'none'`) and **`formatPendingAction(action)`**, which renders the untrusted seller message as safe text, are exported from the root. Names match the Python SDK (`next_step`, `format_pending_action`).
- **Migration:** code that read `status` or `account_id` from `ensure`'s result should switch on `outcome.kind`. The old call, with its `ProvisionedAccount` result, is now `client.accounts.provision(account, options)`, with the same arguments.
