---
'@adcp/sdk': patch
---

`comply_test_controller` now answers at the caller's served AdCP release, as spec tools do (DR-0024, #3769). It's registered after `createAdcpServer` returns, through `registerTestController`, `createComplyController().register` or `createAdcpServerFromPlatform`, so it never selected a release and always answered in the server's own. For example, a 3.2-pinned storyboard runner calling a 3.3 seller received 3.3-only fields such as `forced.proposal_id`.

On an `AdcpServer`, the controller now:

- selects the served release from the request's `adcp_version` / `adcp_major_version`, as the dispatcher does;
- refuses a pin the server can't serve with `VERSION_UNSUPPORTED`, before the controller runs;
- converts its response down to the served release, and refuses with `VERSION_UNSUPPORTED` when the result holds a value that release can't express, such as a 3.3-only `forced.arm`;
- echoes `adcp_version`.

`TOOL_INPUT_SHAPE` gains optional `adcp_version` and `adcp_major_version`, the request's version envelope, so they survive input parsing. On a platform server, the release is selected only after the visibility gate, so a principal that can't see the controller still gets `MethodNotFound`. A controller on a raw SDK `McpServer` behaves as before.
