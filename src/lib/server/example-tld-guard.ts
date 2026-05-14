export interface AssertNoExampleTldsOptions {
  allowIn?: readonly string[];
  checklistPath?: string;
  env?: string;
}

type ExampleTldConstants = Record<string, string | readonly string[] | null | undefined>;

const DEFAULT_ALLOWED_ENVS = ['test', 'development'] as const;
const EXAMPLE_TLD_PATTERN = /(?:^|[/:@.\s])[\w-]+\.example(?=$|[/:?#\s"'`<>)\],;}])/i;

function valuesFor(value: string | readonly string[] | null | undefined): readonly string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value;
  return [];
}

export function assertNoExampleTlds(constants: ExampleTldConstants, opts: AssertNoExampleTldsOptions = {}): void {
  const env = opts.env ?? process.env.NODE_ENV;
  const allowIn = opts.allowIn ?? DEFAULT_ALLOWED_ENVS;
  if (env !== undefined && allowIn.includes(env)) return;

  for (const [key, value] of Object.entries(constants)) {
    if (valuesFor(value).some(entry => EXAMPLE_TLD_PATTERN.test(entry))) {
      const checklist = opts.checklistPath ? ` in ${opts.checklistPath}` : '';
      throw new Error(`Adapter forked without flipping ${key}; see FORK CHECKLIST${checklist}`);
    }
  }
}
