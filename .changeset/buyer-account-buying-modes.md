---
'@adcp/sdk': minor
---

Honor seller-declared buying modes and account requirements before get_products dispatch. Calls without a brief no longer assume wholesale unless the seller declares it. Add a public account resolver that selects a single active seller-assigned account or syncs a buyer-declared natural key, and use it in media-buy storyboards.
