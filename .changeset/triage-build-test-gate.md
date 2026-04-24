---
"@adcp/client": patch
---

Triage routine now runs a mandatory pre-PR build+test gate (npm run ci:quick) before expert review, capped at 2 build→fix iterations.
