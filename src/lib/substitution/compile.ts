/**
 * Vendor-neutral compilation of source macro templates into AdCP universal
 * macros.
 *
 * Vendor detection and mapping knowledge deliberately remain caller-owned.
 * A caller selects a dialect and supplies exact, evidence-backed mappings;
 * this helper performs deterministic tokenization, validation, replacement,
 * and source-offset reporting without guessing what an unknown token means.
 */

import { UniversalMacroSchema } from '../types/schemas.generated';

export type SourceMacroSyntax = 'adcp' | 'double_brace' | 'percent' | 'dollar_brace' | 'bracket';

export interface MacroDocumentationReference {
  title: string;
  url: string;
  source_version?: string;
  retrieved_at?: string;
  content_hash?: string;
}

export interface SourceMacroRequirement {
  kind: string;
  value?: string;
  description: string;
}

export interface SourceMacroMapping {
  /** Exact source token, including delimiters. */
  source_token: string;
  /** Canonical AdCP token, including braces. */
  universal_macro: `{${string}}`;
  source_dialect: string;
  semantic?: string;
  documentation?: readonly MacroDocumentationReference[];
  requirements?: readonly SourceMacroRequirement[];
}

export interface CompileUniversalMacroTemplateInput {
  template: string;
  source_dialect: string;
  mappings: readonly SourceMacroMapping[];
  /** Fail mappings without documentation provenance. Defaults to true. */
  require_documentation?: boolean;
}

export interface UniversalMacroOccurrence {
  source_token: string;
  universal_macro?: `{${string}}`;
  source_dialect: string;
  semantic?: string;
  syntax: SourceMacroSyntax;
  status: 'canonical' | 'mapped' | 'unresolved';
  start: number;
  end: number;
  documentation: MacroDocumentationReference[];
  requirements: SourceMacroRequirement[];
}

export interface UniversalMacroCompileDiagnostic {
  code:
    | 'malformed_macro'
    | 'unknown_macro'
    | 'invalid_universal_macro'
    | 'mapping_provenance_required'
    | 'duplicate_mapping';
  severity: 'error';
  message: string;
  source_token?: string;
  start?: number;
  end?: number;
}

export interface CompileUniversalMacroTemplateResult {
  source_template: string;
  canonical_template: string;
  source_dialect: string;
  occurrences: UniversalMacroOccurrence[];
  diagnostics: UniversalMacroCompileDiagnostic[];
  publishable: boolean;
}

interface MacroToken {
  source_token: string;
  syntax: SourceMacroSyntax;
  start: number;
  end: number;
}

function balancedDollarBraceEnd(template: string, start: number): number | null {
  let depth = 1;
  let index = start + 2;

  while (index < template.length) {
    if (template.startsWith('${', index)) {
      depth += 1;
      index += 2;
      continue;
    }
    if (template[index] === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }

  return null;
}

function tokenize(template: string): {
  tokens: MacroToken[];
  diagnostics: UniversalMacroCompileDiagnostic[];
} {
  const tokens: MacroToken[] = [];
  const diagnostics: UniversalMacroCompileDiagnostic[] = [];
  let index = 0;

  const appendDelimited = (syntax: SourceMacroSyntax, open: string, close: string, endStart: number): boolean => {
    const endMarker = template.indexOf(close, endStart);
    if (endMarker === -1) {
      diagnostics.push({
        code: 'malformed_macro',
        severity: 'error',
        message: `Unclosed ${open}…${close} macro delimiter`,
        start: index,
        end: template.length,
      });
      index = template.length;
      return true;
    }
    const end = endMarker + close.length;
    tokens.push({ source_token: template.slice(index, end), syntax, start: index, end });
    index = end;
    return true;
  };

  while (index < template.length) {
    if (template.startsWith('%%', index)) {
      appendDelimited('percent', '%%', '%%', index + 2);
      continue;
    }
    if (template.startsWith('${', index)) {
      const end = balancedDollarBraceEnd(template, index);
      if (end === null) {
        diagnostics.push({
          code: 'malformed_macro',
          severity: 'error',
          message: 'Unclosed ${…} macro delimiter',
          start: index,
          end: template.length,
        });
        break;
      }
      tokens.push({
        source_token: template.slice(index, end),
        syntax: 'dollar_brace',
        start: index,
        end,
      });
      index = end;
      continue;
    }
    if (template.startsWith('{{', index)) {
      appendDelimited('double_brace', '{{', '}}', index + 2);
      continue;
    }
    if (template[index] === '[' && /^[A-Za-z]/.test(template[index + 1] ?? '')) {
      appendDelimited('bracket', '[', ']', index + 1);
      continue;
    }
    if (template[index] === '{' && /^[A-Za-z]/.test(template[index + 1] ?? '')) {
      appendDelimited('adcp', '{', '}', index + 1);
      continue;
    }
    index += 1;
  }

  return { tokens, diagnostics };
}

function universalMacroName(token: string): string | null {
  const match = token.match(/^\{([A-Z][A-Z0-9_]*)\}$/);
  return match?.[1] ?? null;
}

function isUniversalMacro(token: string): boolean {
  const name = universalMacroName(token);
  return name !== null && UniversalMacroSchema.safeParse(name).success;
}

/**
 * Compile an exact source-dialect mapping into canonical AdCP macros.
 * Unknown tokens remain byte-for-byte visible and make the result
 * unpublishable. Replacements are applied once and never recursively.
 */
export function compileUniversalMacroTemplate(
  input: CompileUniversalMacroTemplateInput
): CompileUniversalMacroTemplateResult {
  const tokenized = tokenize(input.template);
  const diagnostics = [...tokenized.diagnostics];
  const mappingByToken = new Map<string, SourceMacroMapping>();

  for (const mapping of input.mappings) {
    if (mapping.source_dialect !== input.source_dialect) continue;
    if (mappingByToken.has(mapping.source_token)) {
      diagnostics.push({
        code: 'duplicate_mapping',
        severity: 'error',
        message: `More than one ${input.source_dialect} mapping exists for ${mapping.source_token}`,
        source_token: mapping.source_token,
      });
      continue;
    }
    mappingByToken.set(mapping.source_token, mapping);
  }

  const occurrences: UniversalMacroOccurrence[] = [];
  let canonical_template = '';
  let cursor = 0;

  for (const token of tokenized.tokens) {
    canonical_template += input.template.slice(cursor, token.start);

    if (token.syntax === 'adcp' && isUniversalMacro(token.source_token)) {
      occurrences.push({
        source_token: token.source_token,
        universal_macro: token.source_token as `{${string}}`,
        source_dialect: 'adcp',
        semantic: universalMacroName(token.source_token)?.toLowerCase(),
        syntax: token.syntax,
        status: 'canonical',
        start: token.start,
        end: token.end,
        documentation: [],
        requirements: [],
      });
      canonical_template += token.source_token;
      cursor = token.end;
      continue;
    }

    const mapping = mappingByToken.get(token.source_token);
    if (!mapping) {
      occurrences.push({
        source_token: token.source_token,
        source_dialect: input.source_dialect,
        syntax: token.syntax,
        status: 'unresolved',
        start: token.start,
        end: token.end,
        documentation: [],
        requirements: [],
      });
      diagnostics.push({
        code: 'unknown_macro',
        severity: 'error',
        message: `No ${input.source_dialect} mapping exists for ${token.source_token}`,
        source_token: token.source_token,
        start: token.start,
        end: token.end,
      });
      canonical_template += token.source_token;
      cursor = token.end;
      continue;
    }

    const documentation = [...(mapping.documentation ?? [])];
    const requirements = [...(mapping.requirements ?? [])];
    let errorCode: UniversalMacroCompileDiagnostic['code'] | null = null;
    let message = '';
    if (!isUniversalMacro(mapping.universal_macro)) {
      errorCode = 'invalid_universal_macro';
      message = `Mapping for ${token.source_token} targets unsupported ${mapping.universal_macro}`;
    } else if ((input.require_documentation ?? true) && documentation.length === 0) {
      errorCode = 'mapping_provenance_required';
      message = `Mapping for ${token.source_token} has no documentation provenance`;
    }

    if (errorCode) {
      diagnostics.push({
        code: errorCode,
        severity: 'error',
        message,
        source_token: token.source_token,
        start: token.start,
        end: token.end,
      });
      occurrences.push({
        source_token: token.source_token,
        source_dialect: input.source_dialect,
        semantic: mapping.semantic,
        syntax: token.syntax,
        status: 'unresolved',
        start: token.start,
        end: token.end,
        documentation,
        requirements,
      });
      canonical_template += token.source_token;
    } else {
      occurrences.push({
        source_token: token.source_token,
        universal_macro: mapping.universal_macro,
        source_dialect: input.source_dialect,
        semantic: mapping.semantic,
        syntax: token.syntax,
        status: 'mapped',
        start: token.start,
        end: token.end,
        documentation,
        requirements,
      });
      canonical_template += mapping.universal_macro;
    }
    cursor = token.end;
  }

  canonical_template += input.template.slice(cursor);
  return {
    source_template: input.template,
    canonical_template,
    source_dialect: input.source_dialect,
    occurrences,
    diagnostics,
    publishable: diagnostics.length === 0,
  };
}
