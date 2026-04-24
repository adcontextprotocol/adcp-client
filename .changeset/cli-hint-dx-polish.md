---
"@adcp/client": patch
---

Three CLI DX wins for runner hints:

1. **Word-wrap.** Long hint messages (often 250–300 chars) now wrap to terminal width with continuation indent under the message text — first line carries `💡 Hint:`, follow-up lines align so the wrapped block reads as a paragraph, not a runaway line. Width comes from `process.stdout.columns` (TTY), `$COLUMNS` (env), or 100-col fallback. Backtick-fenced identifiers (e.g. `` `pricing_option_id` ``) never split across lines.

2. **Run-summary hint count.** The closing summary line on `adcp storyboard run` now appends `· N hints` when any fired (silent on zero). Single-storyboard, multi-storyboard, and multi-instance summaries all get the suffix. Surfaces diagnostic info without making the operator scroll back through every step.

3. **`adcp storyboard --help` discoverability.** New `OUTPUT:` block explains the `💡 Hint:` line, names the JUnit / JSON surfaces, and links to `docs/guides/VALIDATE-YOUR-AGENT.md § Reading hint lines`.
