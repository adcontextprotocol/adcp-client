---
'@adcp/client': patch
---

Skill files now point Claude at `docs/llms.txt#<tool>` for per-tool field contracts instead of duplicating them inline.

**Callout wording is imperative, not descriptive** (per prompt-engineering review): _"Before writing any handler's return statement, fetch `docs/llms.txt` and grep for `#### \`<tool_name>\``..."_ Replaces the earlier passive "contracts live at X" phrasing that relied on Claude optionally following the pointer. Safety-net sentence reframed as permission ("write the obvious thing and trust the contract") rather than threat.

**Grep instructions match how agents actually find sections**: Markdown anchors resolve on GitHub but Claude reading the raw file searches for `#### \`tool_name\``. The callout names that pattern directly.

**build-creative-agent slim** collapses verbose response-shape blocks into a 4-column handler-binding table: `Tool | Handler | Contract | Gotchas`. The Contract column carries a direct anchor link per tool so Claude is likelier to click the one adjacent to the row it's reading than a general pointer three lines up. Asset-shape bullets stay inline (most-drifted fields historically). Net -94 lines on that skill.

**Other 7 skills get the pointer callout only** — structural slims deferred until matrix v12 signal is in. Two variables (pointer + slim) on one skill lets us disambiguate outcomes.

Lands on top of strict validation default in dev (#727/#757) and the llms.txt response-contract generator (#761). Together: llms.txt is canonical, skills are narrative + gotchas, strict validation catches residual drift at call site.
