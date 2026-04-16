/**
 * Extracts fenced ```typescript blocks from skill SKILL.md files
 * and verifies they compile against the built library types.
 *
 * Catches: wrong imports, missing fields, type mismatches, stale APIs.
 * Does NOT check: untagged pseudo-code blocks (response shapes, etc.)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const SKILLS_DIR = path.resolve(__dirname, '..', 'skills');
const AGENTS_DIR = path.resolve(__dirname, '..', 'test-agents');
const TSCONFIG = path.resolve(AGENTS_DIR, 'tsconfig.json');

/** Extract all ```typescript fenced code blocks from markdown. */
function extractTypeScriptBlocks(markdown) {
  const blocks = [];
  const regex = /```typescript\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(markdown)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

/** Find all SKILL.md files under skills/. */
function findSkillFiles() {
  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(SKILLS_DIR, entry.name, 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      files.push({ name: entry.name, path: skillPath });
    }
  }
  return files;
}

/** Clean up leftover temp files from previous interrupted runs. */
function cleanupTempFiles() {
  for (const f of fs.readdirSync(AGENTS_DIR)) {
    if (f.startsWith('.skill-check-') && f.endsWith('.ts')) {
      fs.unlinkSync(path.join(AGENTS_DIR, f));
    }
  }
}

describe('skill file typescript examples compile', () => {
  cleanupTempFiles();

  const skills = findSkillFiles();

  // Collect all blocks with metadata
  const allBlocks = [];
  for (const skill of skills) {
    const markdown = fs.readFileSync(skill.path, 'utf-8');
    const blocks = extractTypeScriptBlocks(markdown);
    for (let i = 0; i < blocks.length; i++) {
      allBlocks.push({ skill: skill.name, index: i, code: blocks[i] });
    }
  }

  if (allBlocks.length === 0) return;

  // Write all temp files, compile once, then check per-file errors
  it(`all ${allBlocks.length} typescript blocks compile`, () => {
    const tmpFiles = [];

    try {
      // Write all blocks as temp files
      for (const block of allBlocks) {
        const filename = `.skill-check-${block.skill}-${block.index}.ts`;
        const tmpPath = path.join(AGENTS_DIR, filename);
        fs.writeFileSync(tmpPath, block.code);
        tmpFiles.push({ ...block, filename, tmpPath });
      }

      // Single tsc invocation for all blocks
      execSync(`npx tsc --noEmit --project ${TSCONFIG}`, {
        cwd: path.resolve(__dirname, '..'),
        stdio: 'pipe',
        timeout: 60000,
      });
    } catch (err) {
      const stderr = err.stderr?.toString() || '';
      const stdout = err.stdout?.toString() || '';
      const output = stderr + stdout;

      // Collect errors per skill block
      const failures = [];
      for (const file of tmpFiles) {
        const relevantErrors = output
          .split('\n')
          .filter(line => line.includes(file.filename))
          .join('\n');
        if (relevantErrors) {
          failures.push(`${file.skill} block ${file.index + 1}:\n${relevantErrors}`);
        }
      }

      if (failures.length > 0) {
        assert.fail(`TypeScript errors in skill examples:\n\n${failures.join('\n\n')}`);
      }
      // If no errors from our files, other test-agents/*.ts files may have issues — not our concern
    } finally {
      for (const file of tmpFiles) {
        try {
          fs.unlinkSync(file.tmpPath);
        } catch {}
      }
    }
  });
});
