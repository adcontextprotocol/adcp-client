---
'@adcp/sdk': patch
---

Synchronize with AdCP 3.2.4 and regenerate protocol types and validators. Accept the experimental `REVISION_UNREADABLE` issue with its seller attribution, obligation/revision identifiers, and severity-specific action. Preserve canonical conditional requirements in generated Zod validators. Open issues on published revisions keep the affected obligation degraded until they retire, including health-filtered snapshot pages. Invalid unreadable-revision records on an owned obligation fail with a nondisclosing operational response; unrelated records remain excluded. Existing issue-code health behavior is preserved.
