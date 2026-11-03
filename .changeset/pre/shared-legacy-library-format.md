---
'@adcp/sdk': patch
---

Fix legacy `sync_creatives` projection when packages prefer different format IDs but accept a shared reference. Try shared advertised identities before refusing, so a library upload can use sized `display_html` alongside a package declaring unsized `display_html`. Preserve format ownership, selected options, size and duration constraints, and refusals when several shared identities remain ambiguous.
