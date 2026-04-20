---
'@adcp/client': patch
---

Fix `adcp storyboard run <agent> --file <path.yaml>` erroring out with "Cannot combine a storyboard ID with --file". The CLI parser was not stripping `--file` and its value from the positional-argument list, so the file path collided with the storyboard-ID slot (adcp-client#637). `--file=<path>` (equals form) is now parsed too.
