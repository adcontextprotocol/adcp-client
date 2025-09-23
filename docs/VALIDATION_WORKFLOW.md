# Local CI Validation Workflow

This document describes the local validation workflow that mirrors GitHub Actions CI exactly, ensuring you catch issues before they reach CI.

## Quick Start

```bash
# Install git hooks (one-time setup)
npm run hooks:install

# Run full CI validation (mirrors all GitHub Actions checks)
npm run ci:validate

# Quick validation for development
npm run ci:quick
```

## Available Commands

### Core Validation Commands

| Command | Purpose | Time | When to Use |
|---------|---------|------|-------------|
| `npm run ci:validate` | Full CI validation (mirrors GitHub Actions exactly) | ~2-3 min | Before pushing major changes |
| `npm run ci:quick` | Quick validation (typecheck + build + test) | ~30s | During development |
| `npm run ci:schema-check` | Schema synchronization check | ~15s | When working with schemas |
| `npm run ci:pre-push` | Pre-push validation (schema + quick) | ~45s | Automatically runs before push |

### Git Hook Management

| Command | Purpose |
|---------|---------|
| `npm run hooks:install` | Install pre-push validation hook |
| `npm run hooks:uninstall` | Remove pre-push validation hook |

## What Gets Validated

### 1. Schema Synchronization (`ci:schema-check`)
- ✅ Downloads latest AdCP schemas
- ✅ Regenerates TypeScript types
- ✅ Checks for uncommitted changes
- ✅ Validates version synchronization

### 2. TypeScript & Build (`ci:quick`)
- ✅ TypeScript type checking
- ✅ Library build
- ✅ All tests
- ✅ Full project build

### 3. Code Quality (`ci:validate` only)
- ✅ Package.json integrity
- ✅ Export file validation
- ✅ Security audit
- ✅ Publish dry run

## Workflow Integration

### Pre-Push Hook (Recommended)

The pre-push hook automatically runs validation before every `git push`:

```bash
# Install once
npm run hooks:install

# Now every git push will validate first
git push origin feature-branch
# 🔍 Running pre-push validation...
# ✅ Pre-push validation passed! Proceeding with push...
```

### Development Workflow

```bash
# 1. Make changes
# 2. Quick check during development
npm run ci:quick

# 3. Before committing schema changes
npm run ci:schema-check

# 4. Before pushing (or let pre-push hook handle it)
npm run ci:validate

# 5. Push with confidence
git push
```

### CI Failure Recovery

If GitHub Actions fails:

```bash
# 1. Run full validation locally
npm run ci:validate

# 2. Fix any issues reported
# 3. Commit fixes
# 4. Push again
```

## Common Scenarios

### Schema Out of Sync

```bash
❌ Schema changes detected - types are out of sync
   Run: npm run sync-schemas && npm run generate-types

# Fix with:
npm run sync-schemas
npm run generate-types
git add src/lib/types/ src/lib/agents/
git commit -m "chore: update generated types"
```

### TypeScript Errors

```bash
❌ TypeScript type errors found

# Check specific errors:
npm run typecheck

# Fix errors and test:
npm run ci:quick
```

### Test Failures

```bash
❌ Tests failed

# Run tests with output:
npm test

# Fix tests and validate:
npm run ci:quick
```

### Security Vulnerabilities

```bash
⚠️  Security vulnerabilities found
   Run: npm audit for details

# Check details:
npm audit

# Fix if needed:
npm audit fix
```

## Performance Tips

### Speed Up Validation

1. **Use quick validation during development:**
   ```bash
   npm run ci:quick  # 30s vs 2-3min
   ```

2. **Schema check only when needed:**
   ```bash
   npm run ci:schema-check  # Only when working with schemas
   ```

3. **Full validation before pushing:**
   ```bash
   npm run ci:validate  # Complete CI mirror
   ```

### Parallel Development

- Use `npm run ci:quick` frequently during development
- Use `npm run ci:validate` before major commits
- Let pre-push hook catch final issues

## Troubleshooting

### Hook Not Running

```bash
# Check if hook is installed
ls -la .git/hooks/pre-push

# Reinstall if needed
npm run hooks:install
```

### Skip Validation (Emergency)

```bash
# Skip pre-push hook (not recommended)
git push --no-verify

# Or uninstall temporarily
npm run hooks:uninstall
```

### Clean State

```bash
# Reset to clean state
git stash
npm run ci:validate
git stash pop
```

## Integration with IDEs

### VS Code

Add to `.vscode/tasks.json`:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "CI: Quick Validation",
      "type": "shell",
      "command": "npm",
      "args": ["run", "ci:quick"],
      "group": "test",
      "presentation": {
        "echo": true,
        "reveal": "always"
      }
    },
    {
      "label": "CI: Full Validation",
      "type": "shell",
      "command": "npm",
      "args": ["run", "ci:validate"],
      "group": "test",
      "presentation": {
        "echo": true,
        "reveal": "always"
      }
    }
  ]
}
```

### Pre-commit Hook Alternative

If you prefer pre-commit instead of pre-push:

```bash
# Manual setup
echo "#!/bin/bash\nnpm run ci:quick" > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

## Success Metrics

When validation passes, you should see:

```
📊 Validation Summary
Total checks: 12
Passed: 12
Failed: 0
Success rate: 100.0%
Duration: 45.2s

✅ All CI checks passed! Ready to push 🚀
```

This means your code will pass GitHub Actions CI with very high confidence.

## Support

If you encounter issues with the validation workflow:

1. Check this guide for common scenarios
2. Run `npm run ci:validate` for detailed error output
3. Compare with the latest GitHub Actions run
4. Check the validation script: `scripts/ci-validate.js`

The validation workflow is designed to be a faithful mirror of GitHub Actions, so local success should predict CI success.