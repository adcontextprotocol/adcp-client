#!/usr/bin/env tsx

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { syncSchemas } from './sync-schemas';
import { generateTypes } from './generate-types';

interface ValidationResult {
  success: boolean;
  message: string;
  details?: string[];
  suggestions?: string[];
}

// Backup and restore generated files for comparison
class FileBackup {
  private backupDir: string;
  private filesToBackup: string[];

  constructor() {
    this.backupDir = path.join(__dirname, '../.schema-validation-backup');
    this.filesToBackup = [
      'src/lib/types/core.generated.ts',
      'src/lib/types/tools.generated.ts',
      'src/lib/agents/index.generated.ts'
    ];
  }

  backup(): void {
    if (existsSync(this.backupDir)) {
      execSync(`rm -rf ${this.backupDir}`);
    }
    mkdirSync(this.backupDir, { recursive: true });

    for (const file of this.filesToBackup) {
      const fullPath = path.join(__dirname, '..', file);
      if (existsSync(fullPath)) {
        const backupPath = path.join(this.backupDir, path.basename(file));
        const content = readFileSync(fullPath, 'utf8');
        writeFileSync(backupPath, content);
      }
    }
  }

  restore(): void {
    for (const file of this.filesToBackup) {
      const fullPath = path.join(__dirname, '..', file);
      const backupPath = path.join(this.backupDir, path.basename(file));
      
      if (existsSync(backupPath)) {
        const content = readFileSync(backupPath, 'utf8');
        writeFileSync(fullPath, content);
      }
    }

    if (existsSync(this.backupDir)) {
      execSync(`rm -rf ${this.backupDir}`);
    }
  }

  compare(): ValidationResult {
    const differences: string[] = [];

    for (const file of this.filesToBackup) {
      const fullPath = path.join(__dirname, '..', file);
      const backupPath = path.join(this.backupDir, path.basename(file));
      
      if (!existsSync(fullPath) && !existsSync(backupPath)) {
        continue; // Both missing, no difference
      }

      if (!existsSync(fullPath)) {
        differences.push(`❌ ${file} was deleted`);
        continue;
      }

      if (!existsSync(backupPath)) {
        differences.push(`✅ ${file} was created`);
        continue;
      }

      const currentContent = readFileSync(fullPath, 'utf8');
      const backupContent = readFileSync(backupPath, 'utf8');

      if (currentContent !== backupContent) {
        differences.push(`🔄 ${file} was modified`);
      }
    }

    if (differences.length === 0) {
      return {
        success: true,
        message: '✅ Generated types match committed types - schemas are in sync'
      };
    }

    return {
      success: false,
      message: '⚠️ Generated types differ from committed types - schema sync needed',
      details: differences,
      suggestions: [
        'Run: npm run sync-schemas',
        'Run: npm run generate-types', 
        'Run: npm run sync-version --auto-update',
        'Commit the updated files'
      ]
    };
  }
}

// Validate that schemas are current and types are generated correctly
async function validateSchemas(): Promise<ValidationResult> {
  console.log('🔍 Validating schema synchronization...');

  const backup = new FileBackup();

  try {
    // 1. Backup current generated files
    console.log('📋 Backing up current generated files...');
    backup.backup();

    // 2. Sync fresh schemas
    console.log('🔄 Syncing fresh schemas from AdCP...');
    await syncSchemas();

    // 3. Generate types from fresh schemas
    console.log('🔧 Generating types from fresh schemas...');
    await generateTypes();

    // 4. Compare with backed up files
    console.log('🔍 Comparing generated vs committed types...');
    const result = backup.compare();

    return result;

  } catch (error) {
    return {
      success: false,
      message: `❌ Schema validation failed: ${error.message}`,
      suggestions: [
        'Check your internet connection',
        'Verify AdCP schema endpoints are accessible',
        'Run npm run sync-schemas manually for detailed errors'
      ]
    };
  } finally {
    // Always restore original files
    backup.restore();
  }
}

// Check if package.json version is aligned with AdCP
function validateVersionAlignment(): ValidationResult {
  try {
    const packagePath = path.join(__dirname, '../package.json');
    const indexPath = path.join(__dirname, '../schemas/cache/latest/index.json');

    if (!existsSync(packagePath)) {
      return {
        success: false,
        message: '❌ package.json not found'
      };
    }

    if (!existsSync(indexPath)) {
      return {
        success: false,
        message: '❌ Schema cache not found',
        suggestions: ['Run: npm run sync-schemas']
      };
    }

    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    const schemaIndex = JSON.parse(readFileSync(indexPath, 'utf8'));

    const libraryAdcpVersion = packageJson.adcp_version;
    const actualAdcpVersion = schemaIndex.adcp_version;

    if (!libraryAdcpVersion) {
      return {
        success: false,
        message: '⚠️ package.json missing adcp_version field',
        suggestions: ['Run: npm run sync-version --auto-update']
      };
    }

    if (libraryAdcpVersion !== actualAdcpVersion) {
      return {
        success: false,
        message: `⚠️ Version mismatch: package.json has ${libraryAdcpVersion}, schemas are ${actualAdcpVersion}`,
        suggestions: ['Run: npm run sync-version --auto-update']
      };
    }

    return {
      success: true,
      message: `✅ Version alignment correct: AdCP v${actualAdcpVersion}`
    };

  } catch (error) {
    return {
      success: false,
      message: `❌ Version validation failed: ${error.message}`
    };
  }
}

// Main validation function
async function validate(): Promise<void> {
  console.log('🔍 AdCP Schema Validation');
  console.log('========================\n');

  const results: ValidationResult[] = [];

  // 1. Validate version alignment
  console.log('1️⃣ Checking version alignment...');
  const versionResult = validateVersionAlignment();
  results.push(versionResult);
  console.log(versionResult.message);
  if (versionResult.suggestions) {
    versionResult.suggestions.forEach(s => console.log(`   💡 ${s}`));
  }
  console.log();

  // 2. Validate schema synchronization
  console.log('2️⃣ Validating schema synchronization...');
  const schemaResult = await validateSchemas();
  results.push(schemaResult);
  console.log(schemaResult.message);
  if (schemaResult.details) {
    schemaResult.details.forEach(d => console.log(`   ${d}`));
  }
  if (schemaResult.suggestions) {
    schemaResult.suggestions.forEach(s => console.log(`   💡 ${s}`));
  }
  console.log();

  // 3. Summary
  const allPassed = results.every(r => r.success);
  
  if (allPassed) {
    console.log('🎉 All validations passed!');
    console.log('✅ Schemas are synchronized and types are up to date');
    process.exit(0);
  } else {
    console.log('❌ Some validations failed');
    console.log('🔧 Please fix the issues above and run validation again');
    process.exit(1);
  }
}

// CLI execution
if (require.main === module) {
  validate().catch(error => {
    console.error('❌ Validation script failed:', error);
    process.exit(1);
  });
}

export { validateSchemas, validateVersionAlignment };