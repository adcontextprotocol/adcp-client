---
'@adcp/sdk': patch
---

feat(server): dev-mode warning when multi-id read tools (`getMediaBuyDelivery`, `getMediaBuys`, `listCreatives`, `getSignals`) return fewer rows than requested — catches the canonical `ids[0]`-truncation bug class at adapter-development time. Quiet in production and suppressible via `ADCP_SUPPRESS_MULTI_ID_WARN=1`. Closes #1399; refs #1410.
