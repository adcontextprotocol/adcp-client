---
"@adcp/client": patch
---

Add configurable log levels to PropertyCrawler to reduce noise from expected failures. The PropertyCrawler now accepts a `logLevel` option ('error' | 'warn' | 'info' | 'debug' | 'silent') that controls logging verbosity. Expected failures (404s, HTML responses, missing .well-known/adagents.json files) are now logged at debug level instead of error/warn level, while unexpected failures remain at error level. This prevents log pollution when domains don't have adagents.json files, which is a common and expected scenario.
