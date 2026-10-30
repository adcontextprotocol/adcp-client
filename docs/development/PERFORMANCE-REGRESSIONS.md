# Performance regression checks

The performance harness reproduces MCP output-schema recompilation from [#3530](https://github.com/adcontextprotocol/adcp-client/issues/3530) using the actual bundled AdCP 3.2.x schemas (requested as 3.2.7; the resolved release and hashes are recorded). It also checks compilation and repeated validation memory, generated function size, and compiler retention after LRU eviction. No external agent, credentials, or network access beyond loopback is needed.

After installing dependencies and building the library:

```bash
npm run build:lib
npm run test:performance
npm run perf:compare
```

`test:performance` checks the current implementation. `perf:compare` additionally runs three negative controls in separate processes: the original per-client validator behavior, compilation without schema factoring, and a bounded outer LRU with an unbounded shared Ajv underneath. The comparison succeeds only if the current implementation passes and each negative control completes and trips a regression guard. A crash or watchdog timeout does not count as a successful negative control.

The terminal prints a comparison table. Full measurements go to `.context/performance.json`, including schema hashes and sizes, resolved AdCP version, Node/V8/CPU details, phase measurements, per-listing memory observations, and the exact budgets. Use `--output path.json` to retain multiple runs.

## Reproduce a prolonged production workload

```bash
npm run perf:compare -- \
  --scenario mcp-discovery \
  --connections 20 \
  --listings 2 \
  --tools get_products,list_creative_formats,sync_creatives \
  --timeout-ms 600000 \
  --heap-mb 4096 \
  --output .context/mcp-stress.json
```

This intentionally runs the expensive old behavior before the fixed implementation. Its duration and memory usage depend on the machine; it does not claim to replicate a particular production duration or absolute RSS. Each child has its own heap cap and an externally enforced wall-time deadline. The defaults are 2 GiB of V8 heap and three minutes per child. The heap cap is not an RSS limit: native allocations and buffers contribute additional memory.

For a standalone failing reproduction, use `--scenario mcp-discovery --mode uncached` with `npm run test:performance`. It exits nonzero when a resource budget is exceeded. `--scenario mcp-output-validation --mode unfactored` reproduces oversized generated validators. The function-size guard rejects these before repeated execution, which can otherwise trigger several GiB of native-memory growth beyond the V8 heap cap. `--mode leaky --scenario schema-cache-churn` reproduces hidden Ajv retention after eviction.

## What is guarded

The discovery workload uses official MCP HTTP clients and server transports. The fixed path calls the SDK's real `connectMCP()` constructor; the old path constructs an official client without `jsonSchemaValidator`. Both receive independently parsed responses over HTTP. The fixture publishes unmodified protocol constraints, removing only the root `$id` to match the affected sellers. Its response cap is explicitly 32 MiB because the real discovery document exceeds the SDK's default 4 MiB.

The default workload lists two large tools twice across three distinct agent endpoints. Cold compilation is measured separately from repeated discovery. Checks cover:

- **Compilation count:** each output schema compiles once during cold discovery, with zero compilations on subsequent listings or new connections. This guard is deterministic and catches the original regression regardless of machine speed.
- **CPU and event-loop stalls:** repeated discovery has a generous CPU budget relative to cold compilation and a 1.5-second maximum event-loop delay. These detect expensive work beyond schema compilation. Cold compilation remains synchronous; its timings are reported separately.
- **Transient memory:** a 512 MiB process peak RSS budget catches large spikes. The OS high-water mark includes setup and cold compilation and captures peaks even while JavaScript timers cannot run. Per-listing snapshots alone could miss those spikes.
- **Retained memory:** full collections bracket each phase, with a 64 MiB retained-heap growth allowance for repeated discovery.

Each shared cache is bounded by both 256 entries and 64 MiB of serialized schema bytes. Oversized schemas validate without being cached. The byte allowance bounds retained input documents; parsed objects and generated validator code contribute additional memory.

Large remote schemas are factored into small referenced functions before compilation by the official MCP Ajv provider. This keeps both cold code generation and V8's subsequent compilation of hot validators bounded. Seller `$id` scopes are preserved, references are made absolute before moving nodes, and pointer-addressed paths remain present. Dynamic or recursive reference scopes and unsupported URI shapes retain the original schema. Small schemas retain the ordinary compile path. Both MCP eras retain their existing dialect and format behavior.

The output-validation workload compiles the same two real response schemas and performs 8,000 checks over valid empty responses and invalid nested objects. It measures the actual Ajv function graph, including referenced functions, enforcing a 512 KiB maximum per generated function and a 512 MiB process peak RSS budget. Oversized functions skip execution and fail both the size and completed-validation-count guards. The unfactored control compiles each schema only once: it detects dangerous generated code independently of repeated-discovery caching. This prevents a discovery-only benchmark from overlooking memory growth during real response validation.

The churn workload compiles 48 revisions of a smaller real response schema with the production 256-entry limit and a scaled byte budget holding eight revisions. Revisions change only `$comment`. After full collection, weak references verify that at most eight compiled schema documents remain reachable, proving eviction by bytes even below the entry cap. This catches an unbounded outer map, missing byte eviction, and an Ajv instance silently retaining evicted schemas. A separate 16 MiB retained-heap growth budget supplements the reachability check.

Timing and memory budgets are deliberately coarse, while compilation and reachability guards are strict. A changed protocol bundle or dependency may require investigating a budget failure; review the report before changing a limit. Do not replace strict operation-count checks with timing thresholds.

## Continuous integration and new workloads

The existing required **Unit Tests Slow** lane runs `test:performance` serially before its other tests, using the verified Library Build artifact. Results appear in the GitHub job summary and are uploaded as `sdk-performance-<run id>` for 14 days, including failing measurements. These checks do not run concurrently with unit tests in that job. The smaller harness self-tests run in the normal unit suite and prove that synchronous stalls, missing metrics, worker exceptions, and a blocked worker's deadline produce failures.

To add a workload, export `run({ mode, options, measurePhase, collectGarbage })` from a module in `scripts/performance/scenarios/` and register it in `run.mjs`. Return:

```javascript
return {
  phases: [await measurePhase('operation', exerciseRealOperation)],
  metrics: { expensiveOperations, retainedObjects },
  maximums: { expensiveOperations: 1, retainedObjects: 16 },
};
```

Use representative real inputs, a deterministic count or retention invariant where possible, and coarse resource budgets. Provide a negative-control mode that deliberately restores the expensive behavior so `perf:compare` proves the guard can fail. Each workload runs in a fresh child process, preventing shared caches, JIT state, or previous high-water marks from contaminating another case.

Event-loop delay uses Node's [`monitorEventLoopDelay`](https://nodejs.org/api/perf_hooks.html#perf_hooksmonitoreventloopdelayoptions), armed before the measured work. Process peak RSS uses [`process.resourceUsage().maxRSS`](https://nodejs.org/api/process.html#processresourceusage). Forced-GC heap and reachability checks measure retention, not whether the allocator returns memory to the OS.
