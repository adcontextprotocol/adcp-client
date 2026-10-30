import { collectGarbage, evaluateBudgets, measurePhase, memorySnapshot } from './metrics.mjs';

try {
  const { scenario, mode, options } = JSON.parse(process.argv[2]);
  const { run } = await import(scenario);
  const result = await run({ mode, options, collectGarbage, measurePhase });
  const violations = evaluateBudgets(result.metrics, result.maximums);
  process.send({ ...result, violations, passed: violations.length === 0, memory: memorySnapshot() });
} catch (error) {
  process.send({ passed: false, error: error.stack ?? String(error) });
  process.exitCode = 1;
} finally {
  process.disconnect();
}
