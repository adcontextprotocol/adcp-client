---
'@adcp/client': minor
---

Expand the `comply_test_controller` SDK surface so custom wrappers and session-backed stores don't need to reimplement SDK internals.

**New exports from `@adcp/client` / `@adcp/client/server`**

- `toMcpResponse(response)` — MCP envelope helper (`content` + `structuredContent` + `isError`). Previously module-local; custom wrappers had to re-derive the summary/error shape to stay consistent with `registerTestController`.
- `TOOL_INPUT_SHAPE` — canonical Zod input shape for the tool. Four fields matching `ComplyTestControllerRequest`: `scenario`, `params`, `context`, `ext`. Pass directly to `server.tool(...)` in wrappers that need `AsyncLocalStorage`, sandbox gating, or a custom task store.
- `handleTestControllerRequest(storeOrFactory, input)` — already exported; now the documented entry point for custom wrappers.
- `CONTROLLER_SCENARIOS` — const object mapping typed keys to wire-format scenario names. Use in place of string literals (`'force_account_status'`) for type-safe dispatch. Build-time exhaustiveness guard breaks the build if a new scenario is added upstream without updating the map.
- `SESSION_ENTRY_CAP` (default `1000`) + `enforceMapCap(map, key, label, cap?)` — reject-on-overflow quota guard for session-scoped Maps inside `TestControllerStore` methods. Throws `TestControllerError('INVALID_STATE', …)`, which the dispatcher turns into a typed `ControllerError` response. Rejects rather than LRU-evicts so compliance tests stay deterministic.

**Factory shape for session-backed stores**

`registerTestController(server, storeOrFactory)` now accepts either a plain `TestControllerStore` or a `TestControllerStoreFactory`:

```ts
registerTestController(server, {
  scenarios: [CONTROLLER_SCENARIOS.FORCE_ACCOUNT_STATUS],
  async createStore(input) {
    const session = await loadSession((input.context as { session_id?: string })?.session_id);
    return {
      async forceAccountStatus(id, status) {
        /* closes over live session */
      },
    };
  },
});
```

`createStore` runs once per request with the tool input, so the returned store binds to the current session — solving a silent-data-loss bug class where sellers closed over module-level state (e.g., `WeakMap<SessionState, …>`) that the session lifecycle didn't carry across rehydration.

`list_scenarios` is answered from the declared `scenarios` field without invoking `createStore`, keeping capability discovery stateless and matching storyboard expectations.

**New exports from `@adcp/client` / `@adcp/client/testing`**

- `expectControllerError(result, code)` — narrows a `ComplyTestControllerResponse` to `ControllerError` and asserts the error code. Returns `ControllerErrorWithDetail` (narrowed so `error_detail` is guaranteed `string`).
- `expectControllerSuccess(result, kind?)` — narrows to the success arm and optionally asserts which variant (`'list'` / `'transition'` / `'simulation'`). Overloaded return types let tests skip `if (result.success)` boilerplate.

**Compatibility**

No breaking changes. Plain-store `registerTestController(server, store)` and single-arity `handleTestControllerRequest(store, input)` keep working unchanged. The `ControllerScenario` type union is unchanged; `CONTROLLER_SCENARIOS` is additive.

**Migration note for custom wrappers using top-level `account`**

Some sellers built custom `server.tool('comply_test_controller', ...)` wrappers that route sandbox gating off a top-level `account` field (e.g., `account.sandbox === true`). `TOOL_INPUT_SHAPE` intentionally matches `ComplyTestControllerRequest` in the generated schema, which declares only `scenario`, `params`, `context`, `ext` — so `account` is not included.

Two migration paths:

1. **Move the check to `context`**: route sandbox gating through `context.sandbox` / `context.account_id`. Recommended — this is where AdCP routes per-request envelope data on tools that don't take a structural `account`.
2. **Extend the shape locally**: `const MY_SHAPE = { ...TOOL_INPUT_SHAPE, account: z.object({ sandbox: z.boolean() }).passthrough().optional() };` and pass `MY_SHAPE` to `server.tool(...)`. Documented in the `TOOL_INPUT_SHAPE` JSDoc.

Either path keeps your wrapper functional; only the default `registerTestController` registration uses the minimal schema.
