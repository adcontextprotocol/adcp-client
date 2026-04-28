---
"@adcp/client": patch
---

fix(crawler): skip properties with missing or non-array `identifiers` instead of crashing the crawl. PropertyCrawler now drops malformed entries at parse time and surfaces a per-domain warning; PropertyIndex.addProperty is also defensive so any other caller path stays safe.
