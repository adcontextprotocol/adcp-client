import { defineConfig } from 'tsup';
import { fixImportsPlugin } from 'esbuild-fix-imports-plugin';

// Same recipe as the SDK: `bundle: false` transpiles each module 1:1, so every subpath shares one
// copy of each internal module in CommonJS too (no duplicated classes or module state between
// `@adcp/reporting-storage` and its subpaths), and consumers' bundlers can tree-shake. `@adcp/sdk`
// stays a bare import resolved from the host. Declarations come from `tsc --emitDeclarationOnly`.
export default defineConfig({
  entry: ['src/**/*.ts', '!src/**/*.d.ts'],
  outDir: 'dist',
  format: ['esm', 'cjs'],
  target: 'es2022',
  platform: 'node',
  bundle: false,
  tsconfig: 'tsconfig.json',
  sourcemap: false,
  clean: true,
  dts: false,
  shims: false,
  outExtension({ format }) {
    return { js: format === 'esm' ? '.mjs' : '.js' };
  },
  esbuildPlugins: [fixImportsPlugin()],
});
