import path from 'path';
import { getPackageRoot } from './package-root';

export interface SchemaDataRoots {
  /** dist/lib/schemas-data — populated by scripts/copy-schemas-to-dist.ts. Only exists post-build. */
  builtSchemasDataRoot: string;
  /** schemas/cache — populated by scripts/sync-schemas.ts. Only exists in a source checkout. */
  sourceSchemasCacheRoot: string;
}

export function getSchemaDataRoots(): SchemaDataRoots {
  const root = getPackageRoot();
  return {
    builtSchemasDataRoot: path.join(root, 'dist', 'lib', 'schemas-data'),
    sourceSchemasCacheRoot: path.join(root, 'schemas', 'cache'),
  };
}
