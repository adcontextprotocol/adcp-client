---
'@adcp/client': patch
---

PropertyCrawler: Add browser headers and graceful degradation for missing properties array

**Fixes:**

1. **Browser-Like Headers**: PropertyCrawler now sends standard browser headers when fetching `.well-known/adagents.json` files:
   - User-Agent: Standard Chrome browser string (required by CDNs like Akamai)
   - Accept, Accept-Language, Accept-Encoding: Browser-standard values
   - From: Crawler identification per RFC 9110 (includes library version)

   This resolves 403 Forbidden errors from publishers with CDN bot protection (e.g., AccuWeather, Weather.com).

2. **Graceful Degradation**: When a publisher has a valid `adagents.json` file with `authorized_agents` but no `properties` array, PropertyCrawler now:
   - Infers a default property based on the domain
   - Returns the property as discoverable
   - Includes a warning message to guide publishers to add explicit properties
   - Adds warnings array to `CrawlResult` interface

This enables property discovery even when publishers have completed only partial AdCP setup, improving real-world compatibility.

**Real-World Impact:**
- AccuWeather: Now successfully crawled (was failing with 403)
- Weather.com: Now returns inferred property (was returning nothing)
- Result: Properties discoverable from partial implementations

**Breaking Changes:** None - API remains backward compatible. The `CrawlResult.warnings` field is new but optional.

Fixes #107
