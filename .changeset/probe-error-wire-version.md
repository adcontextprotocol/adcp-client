---
'@adcp/sdk': patch
---

Report the release-precision wire pin in capabilities-probe `VERSION_UNSUPPORTED`
diagnostics. When a seller rejected the probe without echoing the canonical
`adcp_version` / `requested_version` (adcp Python sellers echo
`claimed_version`), the storyboard runner and `comply()` reported the internal
bundle id (`requested "3.2.1"`) even though the wire carried `"3.2"`. The probe
now names the value it actually sent (`3.2.1` -> `3.2`, `3.2.0-rc.7` ->
`3.2-rc.7`, `3.1.24` -> `3.1`) and reads a string `claimed_version` echo.
