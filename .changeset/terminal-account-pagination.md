---
'@adcp/sdk': patch
---

fix(storyboard): mark terminal `list_accounts` pagination walks not applicable

The storyboard runner can now treat a `list_accounts` first page as a response-derived `not_applicable` result when the response proves the cursor walk is terminal, such as a short single-account page without pagination or an explicit `has_more: false` page with trustworthy `total_count`.

Malformed or ambiguous pagination still fails the authored continuation assertions, and seeded multi-account pagination walks keep their continuation requirements live.
