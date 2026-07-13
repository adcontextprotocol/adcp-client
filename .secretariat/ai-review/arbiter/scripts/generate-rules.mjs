import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const RULES_DIR = join(here, '..', '..', 'reviewer', 'rules')
const OUT = join(here, '..', 'src', '_rules.generated.ts')

const ENTRIES = [
  { constName: 'SEVERITY_RULES', file: 'severity.md' },
  { constName: 'DECISION_RULES', file: 'arbiter-decision.md' },
]

function escapeBacktick(text) {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
}

const lines = [
  '// AUTO-GENERATED FILE — do not edit by hand.',
  '// Regenerated from reviewer/rules/severity.md + arbiter-decision.md by scripts/generate-rules.mjs',
  '// (runs automatically via the `prebuild` npm script).',
  '',
]

for (const { constName, file } of ENTRIES) {
  const text = await readFile(join(RULES_DIR, file), 'utf8')
  lines.push(`export const ${constName} = \`${escapeBacktick(text)}\``)
  lines.push('')
}

await writeFile(OUT, lines.join('\n'))
console.log(`Wrote ${OUT}`)
