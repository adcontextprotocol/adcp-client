---
'@adcp/sdk': patch
---

Storyboard runner: `field_value` (and its `allowed_values` / envelope variants) now compares object values with JSON deep equality instead of `JSON.stringify` string equality. The stringify comparison was key-order-sensitive, so a content-equal object whose members serialize in a different order false-negatived the check (observed live: `list_formats_integrity` failed "format_id round-trips verbatim" on `{id, agent_url}` echoed as `{agent_url, id}`). Object member order is not significant per RFC 8259; array element order remains strict, matching the sibling `deepEqual` helpers in `webhook-receiver.ts` and `canonical-format-satisfaction.ts`. Fixes #2327.
