---
'@adcp/sdk': patch
---

Throw structured `VALIDATION_ERROR` errors when client-side request validation fails, so callers can distinguish malformed requests from agent and transport failures without parsing error messages.
