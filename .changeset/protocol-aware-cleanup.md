---
"@adcp/client": patch
---

Enable `--protocol a2a` for storyboard testing. Connection cleanup is now protocol-aware, A2A clients are cached to avoid re-fetching the agent card on every tool call, and the compliance-testing auto-augment log now goes to stderr so it doesn't corrupt `--json` output.
