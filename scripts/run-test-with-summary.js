#!/usr/bin/env node

const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');

function usage() {
  console.error('Usage: node scripts/run-test-with-summary.js --title <title> -- <command> [args...]');
  process.exit(2);
}

const separatorIndex = process.argv.indexOf('--');
const titleIndex = process.argv.indexOf('--title');

if (separatorIndex === -1 || titleIndex === -1 || titleIndex + 1 >= separatorIndex) {
  usage();
}

const title = process.argv[titleIndex + 1];
const command = process.argv[separatorIndex + 1];
const commandArgs = process.argv.slice(separatorIndex + 2);

if (!command) {
  usage();
}

let output = '';
const child = spawn(command, commandArgs, {
  env: process.env,
  shell: false,
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', chunk => {
  process.stdout.write(chunk);
  output += chunk.toString('utf8');
});

child.stderr.on('data', chunk => {
  process.stderr.write(chunk);
  output += chunk.toString('utf8');
});

child.on('error', error => {
  console.error(error.message);
  process.exit(1);
});

child.on('close', (code, signal) => {
  writeSummary(title, output);

  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

function writeSummary(summaryTitle, rawOutput) {
  const rows = parseDurations(rawOutput)
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 20);

  if (rows.length === 0) {
    return;
  }

  const markdown = [
    `### ${escapeMarkdown(summaryTitle)} slowest tests`,
    '',
    '| Duration | Type | Test |',
    '| ---: | --- | --- |',
    ...rows.map(row => {
      const seconds = (row.durationMs / 1000).toFixed(2);
      return `| ${seconds}s | ${escapeCell(row.type || 'test')} | ${escapeCell(row.name)} |`;
    }),
    '',
  ].join('\n');

  console.log(`\n${markdown}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }
}

function parseDurations(rawOutput) {
  const lines = rawOutput
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map(line => line.replace(/\s+$/, ''));
  const rows = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)(?:ok|not ok) \d+ - (.+)$/);

    if (!match) {
      continue;
    }

    const indent = match[1];
    const detailIndent = `${indent}  `;
    let durationMs = null;
    let type = '';

    for (let lookahead = index + 1; lookahead < Math.min(lines.length, index + 10); lookahead += 1) {
      if (lines[lookahead] === `${detailIndent}...`) {
        break;
      }

      const durationMatch = lines[lookahead].match(new RegExp(`^${escapeRegExp(detailIndent)}duration_ms: ([0-9.]+)$`));
      const typeMatch = lines[lookahead].match(new RegExp(`^${escapeRegExp(detailIndent)}type: '([^']+)'$`));

      if (durationMatch) {
        durationMs = Number(durationMatch[1]);
      }

      if (typeMatch) {
        type = typeMatch[1];
      }
    }

    if (Number.isFinite(durationMs)) {
      rows.push({ name: match[2], durationMs, type });
    }
  }

  return rows;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeCell(value) {
  return escapeMarkdown(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function escapeMarkdown(value) {
  return String(value).replace(/\r?\n/g, ' ').trim();
}
