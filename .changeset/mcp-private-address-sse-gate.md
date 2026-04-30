---
"@adcp/sdk": patch
---

fix(mcp): skip SSE fallback for private/loopback addresses in connectMCPWithFallback

Private-IP and localhost agents always support StreamableHTTP POST; the SSE GET probe returns 405 (correct server behavior) which previously masked the real StreamableHTTP failure and caused misleading errors. The new gate surfaces the root-cause StreamableHTTP error directly for private/loopback URLs.

Also improves StreamableHTTP failure logging: error class name and HTTP status code (from StreamableHTTPError.code) are now included in the debug log entry, making "for reasons not yet pinned down" first-attempt failures diagnosable. The SSE-fallback debug log level changes from info to warning.
