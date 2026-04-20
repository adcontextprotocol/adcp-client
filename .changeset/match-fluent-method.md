---
'@adcp/client': minor
---
Add fluent `result.match({...})` method on `TaskResult`. Mirrors the free-function `match(result, handlers)` so autocomplete on `result.` surfaces the handler-dispatch helper alongside the other accessors. Method is attached non-enumerably by the client when a result leaves `executeTask`/`pollTaskCompletion`/`resumeDeferredTask`, so `JSON.stringify(result)` and `{...result}` are unaffected. For hand-constructed results (test fixtures, custom middleware), call the exported `attachMatch(result)` helper or keep using the free function.
