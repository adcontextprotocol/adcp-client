---
'@adcp/client': patch
---
Storyboard `error_code` validation now reads the spec-canonical `data.errors[0].code` envelope (per `core/error.json`), falling back to legacy locations (`adcp_error.code`, `error_code`, `code`, `error.code`) and the regex on `taskResult.error`. Previously, spec-conformant agents returning `{ errors: [...], context }` had their code extracted via regex instead of typed field access.
