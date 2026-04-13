---
"@adcp/client": minor
---

Add sandbox entity system for storyboard testing and fix documentation gaps

- Fix sync_creatives examples in generative seller SKILL.md (status→action, errors as objects)
- Fix channels enum in TYPE-SUMMARY.md (20 real MediaChannel values, not 8)
- Add PricingOption variant details to TYPE-SUMMARY.md (CPV parameters)
- Add fictional-entities.yaml defining all 14 companies from the AdCP character bible
- Add getSandboxEntities() / getSandboxBrand() / isSandboxDomain() exports from testing module
- Add sandbox boolean to registry OpenAPI spec (ResolvedBrand, BrandRegistryItem, saveBrand)
- Migrate all fictional entity domains to IANA-reserved .example TLD
- Add --sandbox flag to save-brand CLI command
