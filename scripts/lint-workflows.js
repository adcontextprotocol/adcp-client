#!/usr/bin/env node

const { readdir, readFile } = require('node:fs/promises');
const path = require('node:path');
const { createLinter } = require('actionlint');

async function main() {
  const workflowDir = path.join(process.cwd(), '.github', 'workflows');
  const entries = await readdir(workflowDir, { withFileTypes: true });
  const workflowFiles = entries
    .filter(entry => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map(entry => path.join(workflowDir, entry.name))
    .sort();

  if (workflowFiles.length === 0) {
    throw new Error(`No workflow files found in ${path.relative(process.cwd(), workflowDir)}`);
  }

  const lint = await createLinter();
  let issueCount = 0;

  for (const file of workflowFiles) {
    const relativePath = path.relative(process.cwd(), file);
    const input = await readFile(file, 'utf8');
    const results = lint(input, relativePath);

    for (const result of results) {
      issueCount += 1;
      console.error(`${result.file}:${result.line}:${result.column}: ${result.message} [${result.kind}]`);
    }
  }

  if (issueCount > 0) {
    console.error(`GitHub Actions workflow lint failed with ${issueCount} issue(s).`);
    process.exit(1);
  }

  console.log(`GitHub Actions workflow lint passed for ${workflowFiles.length} file(s).`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
