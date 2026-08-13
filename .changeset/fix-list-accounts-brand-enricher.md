---
'@adcp/sdk': patch
---

Keep broad `list_accounts` storyboard requests unscoped instead of injecting a noncanonical root brand or a synthetic account filter, and make stripped-field notices identify request payload drift without incorrectly directing agents to declare noncanonical fields.
