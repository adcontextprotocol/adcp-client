import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setImmediate, setTimeout } from 'node:timers/promises';

export async function collectGarbage() {
  if (!global.gc) throw new Error('Performance workers require --expose-gc');
  // WeakRef targets stay alive until the current job ends. Yield before each
  // full collection so retained-schema checks see collectible objects.
  await setImmediate();
  global.gc();
  await setImmediate();
  global.gc();
}

export function memorySnapshot() {
  return { ...process.memoryUsage(), peakRssBytes: process.resourceUsage().maxRSS * 1024 };
}

export async function measurePhase(name, work) {
  await collectGarbage();
  const before = memorySnapshot();
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  // Arm the monitor before synchronous work; otherwise an entire main-thread
  // stall could happen before its first timer and disappear from the report.
  await setTimeout(20);
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  try {
    await work();
    const wallMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    const beforeGc = memorySnapshot();
    await setTimeout(20);
    delay.disable();
    const eventLoopMaxMs = delay.max / 1e6;
    await collectGarbage();
    return {
      name,
      wallMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      eventLoopMaxMs,
      before,
      beforeGc,
      afterGc: memorySnapshot(),
    };
  } finally {
    delay.disable();
  }
}

export function evaluateBudgets(metrics, maximums) {
  if (Object.keys(maximums).length === 0) return ['No performance budgets declared'];
  return Object.entries(maximums).flatMap(([name, maximum]) => {
    const value = metrics[name];
    if (!Number.isFinite(value) || !Number.isFinite(maximum))
      return [`${name}: missing or non-finite measurement/budget`];
    return value > maximum ? [`${name}: ${value.toFixed(2)} exceeds ${maximum.toFixed(2)}`] : [];
  });
}
