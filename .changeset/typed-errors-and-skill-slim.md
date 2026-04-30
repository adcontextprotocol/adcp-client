---
'@adcp/sdk': minor
---

Ship 20 typed `AdcpError` subclasses + slim `build-decisioning-platform` skill from 947 → 205 lines + enrich enum-validation errors with allowed values.

**Empirical baseline:** Emma matrix v18 (2026-04-30) surfaced two cascading failure classes for LLM-generated sellers:

1. `get_products` returns a `channels` value not in the spec enum → wire response fails schema validation → all subsequent storyboard steps cascade-skip with "unresolved context variables: product_id". The validation error said "must be equal to one of the allowed values" but didn't enumerate them — LLMs (and humans) couldn't self-correct without fetching the schema.
2. `update_media_buy` with bogus `package_id` returned `SERVICE_UNAVAILABLE` instead of `PACKAGE_NOT_FOUND`. The LLM threw a generic exception because the `AdcpError` code catalog wasn't visible at the throw site.

Both failures collapse to "the LLM doesn't know what's in the closed enum at codegen time." This change makes the closed enums visible.

**Typed error classes** (in `@adcp/sdk/server`):

```ts
import {
  PackageNotFoundError, MediaBuyNotFoundError, ProductNotFoundError,
  ProductUnavailableError, CreativeNotFoundError, CreativeRejectedError,
  BudgetTooLowError, BudgetExhaustedError,
  IdempotencyConflictError,
  InvalidRequestError, InvalidStateError, BackwardsTimeRangeError,
  AuthRequiredError, PermissionDeniedError,
  RateLimitedError, ServiceUnavailableError,
  UnsupportedFeatureError,
  ComplianceUnsatisfiedError, GovernanceDeniedError, PolicyViolationError,
} from '@adcp/sdk/server';

throw new PackageNotFoundError('pkg_123');                        // code, recovery, field set automatically
throw new BudgetTooLowError({ floor: 5000, currency: 'USD' });   // floor + currency in details
throw new RateLimitedError(60);                                   // retry_after clamped to spec [1, 3600]
```

Each class encodes the canonical `code` / `recovery` / `field` / `suggestion` shape — adopters pick from a closed set of class imports rather than memorizing 44 string codes plus their recovery semantics.

**Skill slim:** `skills/build-decisioning-platform/SKILL.md` rewritten to 205 lines from 947 (78% reduction). Structure: 5 functions + typed-error catalog + ctx_metadata + serve() + operator checklist + pointers to advanced/. Advanced concerns (HITL, multi-tenant, OAuth, sandbox, compliance, governance, brand-rights, idempotency tuning, state machine) moved to `skills/build-decisioning-platform/advanced/*.md`. Original full content preserved as `advanced/REFERENCE.md`. Empirical hypothesis: LLMs scaffolding from the slim skill build a working agent without reading anything else.

**Validation error enrichment:** `keyword: 'enum'` failures now project `allowedValues: [...]` on the wire envelope's `adcp_error.issues[]` AND replace the opaque "must be equal to one of the allowed values" message with the actual list (e.g., "must be one of: \"display\", \"video\", \"audio\""). Buyers (and LLMs) self-correct on first response without needing the schema.

Backwards-compatible. Adopters using `AdcpError` directly continue to work; typed classes are convenience wrappers. Validation enrichment adds an optional `allowedValues` field; no callers required to read it.

Closes recurring matrix failures from Emma v18.
