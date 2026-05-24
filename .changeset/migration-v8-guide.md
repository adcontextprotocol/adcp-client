---
---

docs: add v7 → v8 migration guide

Net-new `MIGRATION-v8.md` at repo root (mirroring the v2→v3 convention from `MIGRATION-v3.md` on the old branch). Covers:

- **TL;DR** — three changes that handle most adopter code: envelope `status` required, governance/rights field renames, the `4 GB tsc OOM → narrow imports or 8 GB heap` decision.
- **Wire-level changes** that affect both client and server adopters regardless of whether they use the SDK's types — envelope status, `adcp_version` release-precision, governance / rights field renames, `governance_agents[]` items losing `categories`, request schemas going `additionalProperties: true`.
- **Type-level changes** for TS adopters — `ProvisioningMode` / `SettingsUpdateMode` now typed (was passthrough), `AssetVariant` slot widening, `product_card` self-rendering reshape, `get_products.products` now optional with required `cache_scope`, response union → envelope-intersection-wrapped reshape.
- **SDK behavior changes** — schema-loader nested-`$id` strip on bundled responses (unblocks 14 tools), `getBestUnionErrors` walks `ZodIntersection`, 8 GB heap workaround for full-surface adopters.
- **Bundle-split affordance** — per-tool `@adcp/sdk/types/<tool>` subpath imports for adopters who don't want to bump heap, with the LLM-context win called out explicitly.
- **Per-tool checklist table** — scannable "if you use tool X, watch for Y" matrix.
- **Channel pinning + GA promotion** — beta dist-tag mechanics, when `@adcp/sdk` `latest` flips from 7.11.0 to 8.1.0.

README gains a one-line callout next to the install block pointing at the migration guide.

Empty changeset — docs only, no runtime impact, no version bump needed.
