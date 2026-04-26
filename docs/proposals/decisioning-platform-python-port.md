# DecisioningPlatform — Python port plan

The TypeScript scaffold (`src/lib/server/decisioning/`) is the canonical surface. AdCP also ships a Python SDK (the seed for `prebid/salesagent`-style implementations); the Python port needs to preserve the architectural spirit while accepting language-level tradeoffs.

This proposal maps each load-bearing TS construct to its Python equivalent, calls out where Python loses real safety, and documents the runtime fallbacks adopters should expect.

## What ports cleanly

**`AsyncOutcome[T]` discriminated union**. Python adopters use `typing.Union[Sync[T], Submitted[T], Rejected]` or a Pydantic v2 discriminated union with a `kind: Literal['sync' | 'submitted' | 'rejected']` field. The semantic — sync / submitted / rejected as the only three outcomes — is portable. Pattern matching via `match outcome.kind` reads cleanly.

```python
from typing import Generic, Literal, TypeVar
from pydantic import BaseModel

TResult = TypeVar('TResult')

class Sync(BaseModel, Generic[TResult]):
    kind: Literal['sync'] = 'sync'
    result: TResult

class Submitted(BaseModel, Generic[TResult]):
    kind: Literal['submitted'] = 'submitted'
    task_handle: TaskHandle[TResult]
    estimated_completion: datetime | None = None
    message: str | None = None
    partial_result: TResult | None = None

class Rejected(BaseModel):
    kind: Literal['rejected'] = 'rejected'
    error: AdcpStructuredError

AsyncOutcome = Sync[TResult] | Submitted[TResult] | Rejected
```

**`AdcpStructuredError`**. Pydantic model with the same fields (`code`, `recovery`, `message`, `field`, `suggestion`, `retry_after`, `details`). `ErrorCode` is a `Literal[...]` of the 45 spec codes. Python's structural typing accepts arbitrary strings via `str | ErrorCode`; the autocomplete escape hatch the TS version uses (`(string & {})`) doesn't translate but the looseness is the same.

**Per-specialism interfaces** (`SalesPlatform`, `CreativeTemplatePlatform`, `AudiencePlatform`). Use `typing.Protocol` (structural typing) with the methods declared as `async def`. Pydantic doesn't gate Protocols, but `mypy --strict` does, and that's the contract Python adopters opt into.

```python
from typing import Protocol
from .async_outcome import AsyncOutcome

class SalesPlatform(Protocol):
    async def get_products(
        self, req: GetProductsRequest, ctx: RequestContext[Account[TMeta]]
    ) -> GetProductsResponse: ...

    async def create_media_buy(
        self, req: CreateMediaBuyRequest, ctx: RequestContext[Account[TMeta]]
    ) -> AsyncOutcome[MediaBuy]: ...
    # ...
```

**`Account[TMeta]`, `AccountStore[TMeta]`**. Pydantic generic models. `TMeta` defaults to `dict[str, Any]`; adopters who care about type safety subclass with concrete shapes.

**`StatusMappers`**. Plain Protocol with optional methods. Same surface, same semantics.

**`AccountNotFoundError`**. Plain Python exception class. Identical narrow-use semantics — throw only from `accounts.resolve()`.

## What loses real value

### `RequiredPlatformsFor[S]` — the compile-time gate

This is the headline TS feature: claim a specialism, MUST implement its interface. No equivalent in Python — there is no compile step that walks `capabilities.specialisms` and verifies the right Protocols are satisfied.

**Plan**: runtime validation at server boot via `__init_subclass__` + a startup check.

```python
class DecisioningPlatform(ABC):
    capabilities: DecisioningCapabilities
    accounts: AccountStore
    status_mappers: StatusMappers
    sales: SalesPlatform | None = None
    creative: CreativeTemplatePlatform | CreativeGenerativePlatform | None = None
    audiences: AudiencePlatform | None = None

    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        # Defer; called at create_adcp_server() time when capabilities are populated.

# Framework startup:
def validate_platform(platform: DecisioningPlatform) -> None:
    """Raise PlatformConfigError if specialisms claim methods that aren't implemented."""
    required = required_platforms_for(platform.capabilities.specialisms)
    missing = []
    for field, expected_proto in required.items():
        impl = getattr(platform, field, None)
        if impl is None:
            missing.append(f"capabilities claims {expected_proto.__name__}; platform.{field} is None")
            continue
        # Protocol structural check via typing.runtime_checkable:
        if not isinstance(impl, expected_proto):
            missing.append(f"platform.{field} doesn't implement {expected_proto.__name__}")
    if missing:
        raise PlatformConfigError("\n".join(missing))
```

**Cost**: failures surface at server boot, not at compile time. Type checkers (`mypy --strict`, `pyright`) catch SOME of this — they can flag `platform.sales` being `None` when used — but they can't connect `capabilities.specialisms = ['sales-non-guaranteed']` to "must have a non-None `sales` field." That's a runtime invariant in Python.

**Mitigation**: ship `validate_platform()` in the framework; make it run automatically when `create_adcp_server()` is constructed; provide a CI helper (`adcp-validate-platform module:Klass`) so adopters fail fast in unit tests rather than at deploy time.

### Generics ergonomics

TypeScript's `class GAM implements DecisioningPlatform<{ networkId: string }, GamMeta>` flows `TMeta` through `Account<GamMeta>` automatically — every method body has typed `account.metadata.networkId`.

Python's Pydantic generics work but the ergonomics are visibly worse. Adopters subclass:

```python
class GamMeta(BaseModel):
    network_id: str
    advertiser_id: str

class GamConfig(BaseModel):
    network_id: str
    api_version: Literal['v202402', 'v202405']

class GamPlatform(DecisioningPlatform):
    capabilities: DecisioningCapabilities[GamConfig]
    accounts: AccountStore[Account[GamMeta]]

    async def some_method(self, req, ctx: RequestContext[Account[GamMeta]]):
        # ctx.account.metadata.network_id is typed
        ...
```

Most Python adopters will land on `metadata: dict[str, Any]` and accept the safety loss. Document that pattern as the default and the typed path as the upgrade.

### Compile-time `@ts-expect-error` tests

The TS scaffold's `decisioning.type-checks.ts` pins invariants (e.g., "missing `recovery` MUST fail"). Python's equivalent — `# type: ignore[return-value]` plus mypy's `--warn-unused-ignores` — works structurally but is less ergonomic and doesn't run on every test (`mypy` is opt-in, `pyright` similarly). Recommend a `tests/test_type_invariants.py` that uses `mypy.api.run()` to assert "this snippet should produce N errors" — slow, but enforceable in CI.

## What ports identically

Everything else: capability declarations as data (Pydantic models), `TargetingCapabilities` shape (Scope3 and Prebid both already shipped this in Python), `ReportingCapabilities`, `getCapabilitiesFor(account)` per-tenant override (regular `async def`), `taskHandle.notify(update)` (regular method on a runtime object), helpers (`ok`, `submitted`, `rejected`, `unimplemented`, `aggregate_rejected`).

## Migration cost — Prebid salesagent specifically

Prebid's `BaseAdapter` (`src/adapters/base.py`, ~600 LOC) becomes the reference Python implementation of `DecisioningPlatform`. Concrete adapters (~2400 LOC for GAM) lose ~25-50% of their boilerplate as the framework absorbs idempotency, audit logging, MCP/A2A wire mapping, governance threading, and HITL workflow plumbing.

Specifically:
- `manual_approval_required` + `workflow_step_id` + `task_management.py` → `AsyncOutcome.submitted({ task_handle, partial_result })` and `task_handle.notify(...)`
- `update_media_buy(action: str, ...)` → `update_media_buy(buy_id, patch, ctx)` with local action-verb dispatch
- `validate_media_buy_request(...) -> list[str]` → `aggregate_rejected(errors)` returning a single `Rejected` with `details.errors: [...]`
- `manual_approval_required` per-tenant config → `get_capabilities_for(account)` returning a tenant-scoped `DecisioningCapabilities`

## Open questions for Python port

1. **Async runtime**. The TS scaffold uses `Promise<T>`; Python uses `async def`. This is fine — same semantics. But adopters who currently write sync handlers (rare but possible) need to flip to async, which is a separate refactor. Recommendation: Python framework requires `async def`; document the migration path for sync codebases.

2. **Pydantic version**. Pydantic v2 is required (discriminated unions, generic models). Drop v1 support cleanly.

3. **Type-checker baseline**. Specify `mypy --strict` (or `pyright --strict`) as the supported development experience. Adopters running looser modes get fewer compile-time guarantees but still get runtime validation.

4. **Wire-tool catalog parity**. The `TOOL_REGISTRY` (mapping tool name → specialism + method path) ships once in the TS framework and once in the Python framework. Both must derive from the same source of truth (`schemas/cache/<version>/tools.yaml` or equivalent). Codegen this from the spec; don't hand-maintain in two places.

## Bottom line

Python loses one architectural property (compile-time capability gating) and one ergonomic feature (generic flow-through to method bodies). Both are workable. The runtime validator at server boot is the substitute for the compile-time gate; `dict[str, Any]` is the default for `TMeta`. Everything else ports cleanly.

The most important thing the Python framework SHOULD ship that the TS framework doesn't need: a `validate_platform()` startup check that fails with a clear list of "claimed `X`; missing `Y`" diagnostics. That closes the gap.

Status: design intent. Implementation lands alongside the TS framework refactor (v6.0).
