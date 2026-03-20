---
'@adcp/client': minor
---

Re-export commonly needed nested types (PackageUpdate, Package, Destination, SignalFilters, PricingOption, PriceGuidance, Episode, ShowSelector) from main entry point. Add typesVersions to package.json so subpath imports work under moduleResolution: node. Fix ./types subpath to include runtime entries for Zod schema imports.
