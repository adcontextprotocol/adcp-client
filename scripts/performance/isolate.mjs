import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Run each workload in a fresh process with its own heap cap and watchdog. */
export function runIsolatedScenario({ scenario, mode = 'cached', options = {}, timeoutMs = 180_000, heapMb = 2048 }) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = fork(
      fileURLToPath(new URL('./worker.mjs', import.meta.url)),
      [JSON.stringify({ scenario, mode, options })],
      {
        execArgv: ['--expose-gc', `--max-old-space-size=${heapMb}`],
        env: { ...process.env, NODE_ENV: 'test' },
        silent: true,
      }
    );
    let result;
    let output = '';
    let timedOut = false;
    const capture = chunk => {
      output = (output + chunk).slice(-16_384);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('message', message => {
      result = message;
    });
    // The watchdog lives outside the worker's event loop: synchronous stalls
    // cannot prevent termination, unlike a timeout in the measured process.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      resolve({ passed: false, error: error.message });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const error = timedOut
        ? `Worker exceeded ${timeoutMs} ms wall-time budget`
        : code !== 0 || !result
          ? (result?.error ?? `Worker exited with code ${code}, signal ${signal}`)
          : undefined;
      resolve({
        ...result,
        ...(error && { passed: false, error }),
        processWallMs: Date.now() - started,
        ...(output && { output }),
      });
    });
  });
}
