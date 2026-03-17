/**
 * Convince Engine — AI-Assessed Merchandising Quality
 *
 * Runs sample briefs against an agent's get_products endpoint
 * and uses an LLM to evaluate the quality of responses.
 *
 * comply  → "Your agent works"
 * convince → "Your agent sells"
 */

import { createTestClient, discoverAgentProfile, resolveBrand } from '../client';
import type { TestOptions, TaskResult, AgentProfile } from '../types';
import type { GetProductsResponse } from '../../types/tools.generated';
import { SAMPLE_BRIEFS } from './briefs';
import type {
  SampleBrief,
  ConvinceResult,
  ScenarioAssessment,
  DimensionScore,
  ConvinceDimension,
  ConvinceRating,
  ConvincePattern,
  ConvinceOptions,
} from './types';

const EVALUATION_PROMPT = `You are an expert ad tech buyer evaluating a sales agent's product catalog response.

A buyer sent a brief to a sales agent requesting advertising products. Below is the brief and the agent's response. Evaluate the response across these dimensions:

1. **relevance** — Do the returned products match the brief's audience, format, and objective?
2. **specificity** — Are products tailored to this brief or generic inventory?
3. **completeness** — Are the fields populated that buyers use to decide? (audience, targeting, pricing, descriptions)
4. **pricing** — Is the pricing model appropriate for the brief's goals and budget?
5. **merchandising** — Would a buyer pick this over a competitor's response? Are product names compelling vs internal codes?

Rate each dimension as "strong", "moderate", or "weak" with a specific observation (not generic).

Then provide:
- A 2-3 sentence summary of the overall quality
- Top 3 specific, actionable improvements (not generic advice)

IMPORTANT: Be specific. Reference actual product names, field values, and counts from the response. Do not give generic advice like "add more targeting" — say "3 of 5 products have no audience fields; add demographic or interest targeting to the Premium Display product."

Respond in this exact JSON format:
{
  "dimensions": [
    {"dimension": "relevance", "rating": "strong|moderate|weak", "observation": "..."},
    {"dimension": "specificity", "rating": "strong|moderate|weak", "observation": "..."},
    {"dimension": "completeness", "rating": "strong|moderate|weak", "observation": "..."},
    {"dimension": "pricing", "rating": "strong|moderate|weak", "observation": "..."},
    {"dimension": "merchandising", "rating": "strong|moderate|weak", "observation": "..."}
  ],
  "summary": "...",
  "top_actions": ["...", "...", "..."]
}`;

/**
 * Call an LLM to evaluate a product response against a brief.
 */
async function evaluateWithLLM(
  brief: SampleBrief,
  products: unknown[],
  options: ConvinceOptions
): Promise<{ dimensions: DimensionScore[]; summary: string; top_actions: string[] }> {
  const userMessage = `## Brief
**Name:** ${brief.name}
**Vertical:** ${brief.vertical}
**Budget:** ${brief.budget_context || 'Not specified'}
**Expected Channels:** ${brief.expected_channels?.join(', ') || 'Any'}

${brief.brief}

## Evaluation Hints
${brief.evaluation_hints}

## Agent Response
Products returned: ${products.length}

\`\`\`json
${JSON.stringify(products, null, 2).slice(0, 8000)}
\`\`\``;

  let responseText: string;

  if (options.anthropic_api_key) {
    responseText = await callAnthropic(EVALUATION_PROMPT, userMessage, options.anthropic_api_key, options.model);
  } else if (options.gemini_api_key) {
    responseText = await callGemini(EVALUATION_PROMPT, userMessage, options.gemini_api_key, options.model);
  } else {
    throw new Error('No LLM API key provided. Set --anthropic-key or --gemini-key');
  }

  return parseEvaluation(responseText);
}

async function callAnthropic(system: string, user: string, apiKey: string, model?: string): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as { content: Array<{ text: string }> };
  return data.content[0].text;
}

async function callGemini(system: string, user: string, apiKey: string, model?: string): Promise<string> {
  const geminiModel = model || 'gemini-2.0-flash';
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ parts: [{ text: user }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
  return data.candidates[0].content.parts[0].text;
}

function parseEvaluation(text: string): {
  dimensions: DimensionScore[];
  summary: string;
  top_actions: string[];
} {
  // Extract JSON from the response (handle markdown code blocks)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Could not parse LLM evaluation response as JSON');
  }

  const parsed = JSON.parse(jsonMatch[0]) as {
    dimensions?: Array<{ dimension: string; rating: string; observation: string }>;
    summary?: string;
    top_actions?: string[];
  };
  const validDimensions: ConvinceDimension[] = [
    'relevance',
    'specificity',
    'completeness',
    'pricing',
    'merchandising',
  ];
  const validRatings: ConvinceRating[] = ['strong', 'moderate', 'weak'];

  const dimensions: DimensionScore[] = (parsed.dimensions || [])
    .filter(
      (d) =>
        validDimensions.includes(d.dimension as ConvinceDimension) &&
        validRatings.includes(d.rating as ConvinceRating)
    )
    .map((d) => ({
      dimension: d.dimension as ConvinceDimension,
      rating: d.rating as ConvinceRating,
      observation: d.observation || '',
    }));

  return {
    dimensions,
    summary: parsed.summary || 'No summary provided',
    top_actions: parsed.top_actions || [],
  };
}

export interface FullConvinceOptions extends TestOptions, ConvinceOptions {}

/**
 * Run convince assessment against an agent.
 * Sends sample briefs, evaluates product responses with AI.
 */
export async function convince(
  agentUrl: string,
  options: FullConvinceOptions = {}
): Promise<ConvinceResult> {
  const start = Date.now();

  if (!options.anthropic_api_key && !options.gemini_api_key) {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;
    if (anthropicKey) options.anthropic_api_key = anthropicKey;
    else if (geminiKey) options.gemini_api_key = geminiKey;
    else throw new Error('No LLM API key. Set ANTHROPIC_API_KEY or GEMINI_API_KEY environment variable.');
  }

  const effectiveOptions: TestOptions = {
    ...options,
    dry_run: options.dry_run !== false,
    test_session_id: options.test_session_id || `convince-${Date.now()}`,
  };

  // Discover agent
  const client = createTestClient(agentUrl, effectiveOptions.protocol ?? 'mcp', effectiveOptions);
  const { profile, step: profileStep } = await discoverAgentProfile(client);

  if (!profileStep.passed) {
    return {
      agent_url: agentUrl,
      agent_profile: profile,
      assessments: [],
      patterns: [],
      overall_summary: 'Agent unreachable — cannot assess merchandising quality',
      tested_at: new Date().toISOString(),
      total_duration_ms: Date.now() - start,
      evaluator: options.anthropic_api_key ? 'anthropic' : 'gemini',
      dry_run: effectiveOptions.dry_run !== false,
    };
  }

  if (!profile.tools.includes('get_products')) {
    return {
      agent_url: agentUrl,
      agent_profile: profile,
      assessments: [],
      patterns: [],
      overall_summary: 'Agent does not support get_products — nothing to assess for merchandising quality',
      tested_at: new Date().toISOString(),
      total_duration_ms: Date.now() - start,
      evaluator: options.anthropic_api_key ? 'anthropic' : 'gemini',
      dry_run: effectiveOptions.dry_run !== false,
    };
  }

  // Select briefs to run
  const briefs = options.brief_ids
    ? SAMPLE_BRIEFS.filter(b => options.brief_ids!.includes(b.id))
    : SAMPLE_BRIEFS;

  const assessments: ScenarioAssessment[] = [];

  for (const brief of briefs) {
    try {
      // Call get_products with the sample brief
      const result = (await client.getProducts({
        buying_mode: 'brief',
        brief: brief.brief,
        brand: resolveBrand(effectiveOptions),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bypasses strict request typing
      } as any)) as TaskResult;

      const products: unknown[] = result?.success ? ((result.data as GetProductsResponse)?.products ?? []) : [];

      if (!result?.success) {
        assessments.push({
          brief,
          products_returned: 0,
          dimensions: [],
          summary: `Agent returned error: ${result?.error || 'unknown error'}`,
          top_actions: ['Fix the error returned by get_products before assessing merchandising quality'],
          raw_response: result?.data,
        });
        continue;
      }

      // Evaluate with LLM
      const evaluation = await evaluateWithLLM(brief, products, options);

      assessments.push({
        brief,
        products_returned: products.length,
        dimensions: evaluation.dimensions,
        summary: evaluation.summary,
        top_actions: evaluation.top_actions,
        raw_response: products,
      });
    } catch (error) {
      assessments.push({
        brief,
        products_returned: 0,
        dimensions: [],
        summary: `Error evaluating: ${error instanceof Error ? error.message : String(error)}`,
        top_actions: [],
      });
    }
  }

  // Detect cross-brief patterns
  const patterns = detectPatterns(assessments);

  // Generate overall summary
  const overall_summary = generateOverallSummary(assessments, patterns, profile);

  return {
    agent_url: agentUrl,
    agent_profile: profile,
    assessments,
    patterns,
    overall_summary,
    tested_at: new Date().toISOString(),
    total_duration_ms: Date.now() - start,
    evaluator: options.anthropic_api_key ? 'anthropic' : 'gemini',
    dry_run: effectiveOptions.dry_run !== false,
  };
}

function detectPatterns(assessments: ScenarioAssessment[]): ConvincePattern[] {
  const patterns: ConvincePattern[] = [];

  // Count ratings across all assessments
  const ratingCounts: Record<ConvinceDimension, Record<ConvinceRating, number>> = {
    relevance: { strong: 0, moderate: 0, weak: 0 },
    specificity: { strong: 0, moderate: 0, weak: 0 },
    completeness: { strong: 0, moderate: 0, weak: 0 },
    pricing: { strong: 0, moderate: 0, weak: 0 },
    merchandising: { strong: 0, moderate: 0, weak: 0 },
  };

  for (const assessment of assessments) {
    for (const dim of assessment.dimensions) {
      if (ratingCounts[dim.dimension]) {
        ratingCounts[dim.dimension][dim.rating]++;
      }
    }
  }

  const total = assessments.filter(a => a.dimensions.length > 0).length;
  if (total === 0) return patterns;

  // Find consistently weak dimensions
  for (const [dim, counts] of Object.entries(ratingCounts)) {
    if (counts.weak >= total * 0.6) {
      patterns.push({
        pattern: `${dim} is consistently weak`,
        frequency: `Weak in ${counts.weak} of ${total} briefs`,
        impact: getImpactDescription(dim as ConvinceDimension),
      });
    } else if (counts.strong >= total * 0.6) {
      patterns.push({
        pattern: `${dim} is a strength`,
        frequency: `Strong in ${counts.strong} of ${total} briefs`,
        impact: `This is competitive advantage — maintain and highlight it.`,
      });
    }
  }

  // Check for zero-product responses
  const emptyResponses = assessments.filter(a => a.products_returned === 0).length;
  if (emptyResponses > 0) {
    patterns.push({
      pattern: 'Empty responses to valid briefs',
      frequency: `${emptyResponses} of ${assessments.length} briefs returned 0 products`,
      impact: 'Buyers will move to another agent immediately if they get no products. This is the most impactful issue to fix.',
    });
  }

  // Check for identical product counts (might indicate static catalog)
  const counts = assessments.map(a => a.products_returned).filter(c => c > 0);
  const uniqueCounts = new Set(counts);
  if (counts.length > 2 && uniqueCounts.size === 1) {
    patterns.push({
      pattern: 'Same number of products returned for every brief',
      frequency: `Always ${counts[0]} products across ${counts.length} different briefs`,
      impact: 'Suggests a static catalog rather than brief-responsive product selection. Buyers expect curated results.',
    });
  }

  return patterns;
}

function getImpactDescription(dimension: ConvinceDimension): string {
  switch (dimension) {
    case 'relevance':
      return "Buyers filter on relevance first. Irrelevant products mean you're not even in consideration.";
    case 'specificity':
      return 'Generic products lose to tailored ones. Buyers want to see you understand their brief.';
    case 'completeness':
      return 'Missing fields force buyers to guess. They will pick the agent that gives them complete information.';
    case 'pricing':
      return 'Wrong pricing model signals misalignment. Performance briefs need CPC/CPA, awareness needs CPM.';
    case 'merchandising':
      return 'Product names and descriptions are your first impression. Internal codes vs compelling names is the difference.';
  }
}

function generateOverallSummary(
  assessments: ScenarioAssessment[],
  patterns: ConvincePattern[],
  profile: AgentProfile
): string {
  const withDimensions = assessments.filter(a => a.dimensions.length > 0);
  if (withDimensions.length === 0) {
    return 'Could not assess merchandising quality — no successful product responses to evaluate.';
  }

  // Count overall ratings
  let strong = 0;
  let moderate = 0;
  let weak = 0;
  for (const a of withDimensions) {
    for (const d of a.dimensions) {
      if (d.rating === 'strong') strong++;
      else if (d.rating === 'moderate') moderate++;
      else weak++;
    }
  }

  const total = strong + moderate + weak;
  const strongPct = Math.round((strong / total) * 100);
  const weakPct = Math.round((weak / total) * 100);

  let summary = `Assessed ${withDimensions.length} brief(s) against ${profile.name}. `;
  if (weakPct > 50) {
    summary += `Merchandising quality needs work: ${weakPct}% of dimension scores were weak. `;
  } else if (strongPct > 50) {
    summary += `Strong merchandising: ${strongPct}% of dimension scores were strong. `;
  } else {
    summary += `Mixed results: ${strongPct}% strong, ${weakPct}% weak across all dimensions. `;
  }

  // Add top pattern
  const weakPatterns = patterns.filter(p => p.pattern.includes('weak') || p.pattern.includes('Empty'));
  if (weakPatterns.length > 0) {
    summary += `Key issue: ${weakPatterns[0].pattern.toLowerCase()}.`;
  }

  return summary;
}

/**
 * Format convince results for terminal display.
 */
export function formatConvinceResults(result: ConvinceResult): string {
  let output = '';

  output += `\n🎯  AdCP Convince Report\n`;
  output += `${'─'.repeat(50)}\n`;
  output += `Agent:     ${result.agent_url}\n`;
  output += `Name:      ${result.agent_profile.name}\n`;
  output += `Evaluator: ${result.evaluator}\n`;
  output += `Duration:  ${(result.total_duration_ms / 1000).toFixed(1)}s\n\n`;

  output += `${result.overall_summary}\n\n`;

  // Per-brief results
  for (const assessment of result.assessments) {
    output += `${'─'.repeat(50)}\n`;
    output += `📋 ${assessment.brief.name}\n`;
    output += `   ${assessment.brief.vertical} | ${assessment.brief.budget_context || 'No budget'}\n`;
    output += `   Products returned: ${assessment.products_returned}\n\n`;

    if (assessment.dimensions.length === 0) {
      output += `   ${assessment.summary}\n\n`;
      continue;
    }

    // Dimension scores
    for (const dim of assessment.dimensions) {
      const icon = dim.rating === 'strong' ? '🟢' : dim.rating === 'moderate' ? '🟡' : '🔴';
      output += `   ${icon} ${dim.dimension}: ${dim.observation}\n`;
    }

    output += `\n   ${assessment.summary}\n`;

    if (assessment.top_actions.length > 0) {
      output += `\n   Actions:\n`;
      for (const action of assessment.top_actions) {
        output += `   → ${action}\n`;
      }
    }
    output += '\n';
  }

  // Cross-brief patterns
  if (result.patterns.length > 0) {
    output += `${'─'.repeat(50)}\n`;
    output += `Cross-Brief Patterns\n\n`;
    for (const pattern of result.patterns) {
      output += `   ${pattern.pattern}\n`;
      output += `   ${pattern.frequency}\n`;
      output += `   Impact: ${pattern.impact}\n\n`;
    }
  }

  return output;
}

/**
 * Format convince results as JSON.
 */
export function formatConvinceResultsJSON(result: ConvinceResult): string {
  return JSON.stringify(result, null, 2);
}
