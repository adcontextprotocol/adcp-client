/**
 * Test result formatting for AdCP Agent E2E Testing
 */

import type { TestResult } from './types';

/**
 * Format test results for display in Slack/chat
 */
export function formatTestResults(result: TestResult): string {
  const statusEmoji = result.overall_passed ? '✅' : '❌';
  let output = `## ${statusEmoji} Agent Test Results\n\n`;
  output += `**Agent:** ${result.agent_url}\n`;
  output += `**Scenario:** ${result.scenario}\n`;
  output += `**Duration:** ${result.total_duration_ms}ms\n`;
  output += `**Mode:** ${result.dry_run ? '🧪 Dry Run' : '🔴 Live'}\n`;
  output += `**Result:** ${result.summary}\n\n`;

  // Show agent profile if discovered
  if (result.agent_profile) {
    output += `### Agent Capabilities\n`;
    output += `- **Name:** ${result.agent_profile.name}\n`;
    output += `- **Tools:** ${result.agent_profile.tools.length}\n`;
    if (result.agent_profile.channels?.length) {
      output += `- **Channels:** ${result.agent_profile.channels.join(', ')}\n`;
    }
    if (result.agent_profile.pricing_models?.length) {
      output += `- **Pricing Models:** ${result.agent_profile.pricing_models.join(', ')}\n`;
    }
    if (result.agent_profile.supported_formats?.length) {
      output += `- **Creative Formats:** ${result.agent_profile.supported_formats.length}\n`;
    }
    if (result.agent_profile.supported_signals?.length) {
      output += `- **Signals:** ${result.agent_profile.supported_signals.length}\n`;
    }
    output += '\n';
  }

  output += `### Test Steps\n\n`;

  for (const step of result.steps) {
    const stepEmoji = step.passed ? '✅' : '❌';
    output += `${stepEmoji} **${step.step}**`;
    if (step.task) {
      output += ` (\`${step.task}\`)`;
    }
    output += ` - ${step.duration_ms}ms\n`;

    if (step.details) {
      output += `   ${step.details}\n`;
    }

    if (step.warnings && step.warnings.length > 0) {
      for (const warning of step.warnings) {
        output += `   ${warning}\n`;
      }
    }

    if (step.error) {
      output += `   ⚠️ Error: ${step.error}\n`;
    }

    if (step.response_preview && !step.error) {
      output += `   \`\`\`json\n   ${step.response_preview.split('\n').join('\n   ')}\n   \`\`\`\n`;
    }

    output += '\n';
  }

  if (!result.overall_passed) {
    output += `---\n\n`;
    output += `💡 **Need help?** Ask me about specific errors or check the [AdCP documentation](https://adcontextprotocol.org/docs).\n`;
  }

  return output;
}

/**
 * Format test results as JSON for programmatic use
 */
export function formatTestResultsJSON(result: TestResult): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Format test results as a compact summary
 */
export function formatTestResultsSummary(result: TestResult): string {
  const statusEmoji = result.overall_passed ? '✅' : '❌';
  const passedCount = result.steps.filter(s => s.passed).length;
  const failedCount = result.steps.filter(s => !s.passed).length;
  const warningCount = result.steps.filter(s => s.warnings && s.warnings.length > 0).length;

  let summary = `${statusEmoji} ${result.scenario}: ${passedCount}/${result.steps.length} passed (${result.total_duration_ms}ms)`;
  if (failedCount > 0) {
    summary += ` - ${failedCount} failed`;
  }
  if (warningCount > 0) {
    summary += ` - ⚠️ ${warningCount} warning(s)`;
  }
  return summary;
}
