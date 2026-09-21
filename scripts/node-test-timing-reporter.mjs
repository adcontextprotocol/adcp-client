import path from 'node:path';
import { tap } from 'node:test/reporters';

function normalizeFile(file) {
  const relative = path.relative(process.cwd(), file).split(path.sep).join('/');
  if (relative.startsWith('../') || path.isAbsolute(relative)) return undefined;
  return relative;
}

export function collectFileTiming(timings, event) {
  if (!['test:pass', 'test:fail'].includes(event?.type) || event.data?.nesting !== 0) return;
  const file = event.data.file && normalizeFile(event.data.file);
  const durationMs = event.data.details?.duration_ms;
  if (!file || !file.endsWith('.test.js') || !Number.isFinite(durationMs) || durationMs < 0) return;
  timings.set(file, (timings.get(file) ?? 0) + durationMs);
}

export default async function* timingReporter(source) {
  const timings = new Map();

  async function* observe() {
    for await (const event of source) {
      collectFileTiming(timings, event);

      // Emit the completed snapshot while the reporter is still consuming the
      // source stream. `--test-force-exit` may skip generator cleanup after the
      // final TAP yield, but it cannot skip an event emitted before the plan.
      if (event.type === 'test:plan' && event.data?.nesting === 0 && timings.size > 0) {
        const tests = Object.fromEntries(
          [...timings].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        );
        yield {
          type: 'test:diagnostic',
          data: {
            nesting: 0,
            message: `ADCP_TEST_TIMINGS ${Buffer.from(JSON.stringify(tests)).toString('base64')}`,
          },
        };
      }

      yield event;
    }
  }

  yield* tap(observe());
}
