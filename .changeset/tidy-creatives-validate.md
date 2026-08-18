---
'@adcp/sdk': patch
---

Fix generated creative runtime schemas so manifest and library assets validate their declared asset variants, canonical and legacy identities remain mutually exclusive, and whitespace-padded legacy agent URLs fail validation instead of throwing from a Zod intersection.
