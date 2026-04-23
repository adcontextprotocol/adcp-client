---
'@adcp/client': patch
---

cli: warn on removed flags instead of silently ignoring

`--platform-type` was removed from the SDK in 5.1 (`comply()` throws when it's passed programmatically), but the CLI was still capturing and silently dropping the flag. Third-party CI scripts that pass it today believe they're filtering agent selection when they aren't.

`adcp storyboard run` (and its `adcp comply` deprecated alias) now emits a stderr warning naming the flag, the version it was removed in, and the migration path:

```
[warn] --platform-type was removed in 5.1.0 and is being ignored.
Agent selection is now driven by get_adcp_capabilities (supported_protocols + specialisms).
Pass --storyboards <bundle-or-id> to target a specific bundle.
```

Non-breaking — execution continues. Warnings are suppressed under `--json` to keep stdout as pure JSON. Detection covers both space-separated (`--platform-type value`) and equals (`--platform-type=value`) forms.

The `REMOVED_FLAGS` map in `bin/adcp.js` is a single location to extend as we deprecate additional flags.
