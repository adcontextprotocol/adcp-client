---
"@adcp/sdk": patch
---

fix(types): add `'advertiser'` to `DecisioningCapabilities.supportedBillings`

The `billing-party` schema enum allows `'operator' | 'agent' | 'advertiser'`, but the TypeScript type only declared the first two. Adopters building platforms that bill advertisers directly (Google Ads direct, Meta direct, retail-media-adjacent) could not declare this billing model via the typed interface. The runtime projection (`from-platform.ts`) already passes the value through verbatim, so this is a type-only fix.
