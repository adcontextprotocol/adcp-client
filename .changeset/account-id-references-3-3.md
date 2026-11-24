---
'@adcp/sdk': patch
---

At AdCP 3.3 and later, the buyer client now references a provisioned account by the seller's `account_id` without first requiring `account.stable_account_id`.

AdCP 3.3 (adcontextprotocol/adcp#8474) makes the seller's `account_id` the account's identity. Every seller MUST return it from `sync_accounts`, accept it on every account-scoped task, and never change it. Buyers MUST NOT require the flag before sending it, and the flag is deprecated. `accountReferenceMode: 'auto'` swapped a provisioned natural key for `{ account_id }` only when the seller declared `stable_account_id: true` or both sides were on AdCP 4. The Python SDK already follows the 3.3 rule.

`auto` now sends `{ account_id }` on account-scoped tasks whose negotiated (or pinned) release is 3.3 or later. This covers `get_products`, `sync_creatives`, `create_media_buy` and the rest, and `resolveAccount()` returns the ID reference at those releases. These keep their natural key:

- `sync_accounts` entries and `list_accounts` filters;
- sellers negotiated below 3.3, unless they declare the flag;
- a 3.3 account the seller returned no ID for;
- `accountReferenceMode: 'natural-key'`.

Strict account policy's `get_products` gate is unchanged and still keys off the seller's declaration.
