---
"@adcp/client": minor
---

Improve comply runner signal-to-noise ratio against real agents

- Skip storyboard steps when agent doesn't implement the tool (new `missing_tool` skip reason)
- Detect unresolved `$context` placeholders and skip with `dependency_failed` instead of sending invalid requests
- Catch "Unknown tool" errors from agents and convert to skips
- Add rate limit retry with exponential backoff and jitter (3 retries, 2s/4s/8s base)
- Fix `sync_creatives` request builder to send creatives for all discovered formats, not just the first (#482)
- Fix `mapStepToTestStep` to preserve runner's skip semantics (skips no longer counted as failures)
- Fix `extractErrorData` to handle nested JSON in error messages
- Truncate agent error messages to 2000 chars to prevent report bloat
