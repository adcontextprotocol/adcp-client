/**
 * Vendor-neutral compilation of source macro templates into AdCP universal
 * macros.
 *
 * Vendor detection and mapping knowledge deliberately remain caller-owned.
 * A caller selects a dialect, declares its token syntaxes, and supplies exact,
 * evidence-backed mappings. This helper performs deterministic tokenization,
 * validation, replacement, and source-offset reporting without guessing what
 * an unknown token means.
 */

import { UniversalMacroValues } from '../types/enums.generated';

/**
 * Built-in syntaxes with complete unknown-token scanners. Custom dialects use
 * an explicit delimiter declaration so unknown tokens remain discoverable.
 */
export type BuiltInSourceMacroSyntax = 'adcp' | 'double_brace' | 'percent' | 'dollar_brace' | 'bracket';
export type SourceMacroSyntax = BuiltInSourceMacroSyntax | `custom:${string}` | 'embedded';

export interface CustomSourceMacroSyntax {
  name: string;
  open: string;
  close: string;
}

export type SourceMacroSyntaxDeclaration = BuiltInSourceMacroSyntax | CustomSourceMacroSyntax;

const BUILT_IN_SOURCE_SYNTAXES = new Set<BuiltInSourceMacroSyntax>([
  'adcp',
  'double_brace',
  'percent',
  'dollar_brace',
  'bracket',
]);

const UNIVERSAL_MACRO_NAMES = new Set<string>(UniversalMacroValues);

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

export interface SourceMacroRequirementSatisfaction {
  kind: string;
  value?: string;
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
  /**
   * Syntaxes the selected dialect uses. Unknown-token scanning is limited to
   * this list so ordinary URL, JavaScript, and template syntax is not guessed
   * to be a macro. Every configured mapping must match one declared built-in
   * or custom syntax.
   */
  source_syntaxes: readonly SourceMacroSyntaxDeclaration[];
  mappings: readonly SourceMacroMapping[];
  /** Fail mappings without documentation provenance. Defaults to true. */
  require_documentation?: boolean;
  /**
   * Preserve supported `{ADCP_MACRO}` tokens without a mapping. Defaults to
   * false because a vendor dialect can use the same spelling with a different
   * meaning. Enable only when the input is known to contain canonical AdCP.
   */
  allow_canonical_macros?: boolean;
  /** Attestations for mapping requirements satisfied before publication. */
  satisfied_requirements?: readonly SourceMacroRequirementSatisfaction[];
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
    | 'invalid_mapping_provenance'
    | 'invalid_mapping_requirement'
    | 'invalid_mapping_registry'
    | 'invalid_mapping'
    | 'invalid_source_token'
    | 'mapping_syntax_not_declared'
    | 'duplicate_mapping'
    | 'source_syntax_required'
    | 'unsupported_source_syntax'
    | 'invalid_input'
    | 'invalid_requirement_satisfaction'
    | 'unsatisfied_requirement';
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

interface MappingState {
  mapping: SourceMacroMapping;
  documentation: MacroDocumentationReference[];
  requirements: SourceMacroRequirement[];
  valid: boolean;
}

interface NormalizedCustomSyntax {
  id: `custom:${string}`;
  open: string;
  close: string;
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

function universalMacroName(token: string): string | null {
  const match = token.match(/^\{([A-Z][A-Z0-9_]*)\}$/);
  return match?.[1] ?? null;
}

function isUniversalMacro(token: string): boolean {
  const name = universalMacroName(token);
  return name !== null && UNIVERSAL_MACRO_NAMES.has(name);
}

function syntaxForExactToken(
  token: string,
  builtIns: ReadonlySet<BuiltInSourceMacroSyntax>,
  customSyntaxes: readonly NormalizedCustomSyntax[]
): SourceMacroSyntax | null {
  for (const syntax of customSyntaxes) {
    const firstClose = token.indexOf(syntax.close, syntax.open.length);
    if (
      token.startsWith(syntax.open) &&
      token.length > syntax.open.length + syntax.close.length &&
      firstClose === token.length - syntax.close.length
    ) {
      return syntax.id;
    }
  }
  if (builtIns.has('double_brace') && token.startsWith('{{') && token.indexOf('}}', 2) === token.length - 2) {
    return 'double_brace';
  }
  if (builtIns.has('percent') && token.startsWith('%%') && token.indexOf('%%', 2) === token.length - 2) {
    return 'percent';
  }
  if (builtIns.has('dollar_brace') && token.startsWith('${') && balancedDollarBraceEnd(token, 0) === token.length) {
    return 'dollar_brace';
  }
  if (builtIns.has('bracket') && /^\[[A-Z][A-Z0-9_]*\]$/.test(token)) return 'bracket';
  if (builtIns.has('adcp') && /^\{[A-Z][A-Z0-9_]*\}$/.test(token)) return 'adcp';
  return null;
}

function requirementKey(requirement: SourceMacroRequirementSatisfaction): string {
  return JSON.stringify([requirement.kind, requirement.value === undefined ? null : requirement.value]);
}

function isValidDocumentationReference(value: unknown): value is MacroDocumentationReference {
  if (typeof value !== 'object' || value === null) return false;
  const reference = value as Partial<MacroDocumentationReference>;
  if (typeof reference.title !== 'string' || reference.title.trim() === '') return false;
  if (typeof reference.url !== 'string') return false;
  for (const optionalValue of [reference.source_version, reference.retrieved_at, reference.content_hash]) {
    if (optionalValue !== undefined && typeof optionalValue !== 'string') return false;
  }
  try {
    const url = new URL(reference.url);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

function isValidRequirement(value: unknown): value is SourceMacroRequirement {
  if (typeof value !== 'object' || value === null) return false;
  const requirement = value as Partial<SourceMacroRequirement>;
  return (
    typeof requirement.kind === 'string' &&
    requirement.kind.trim() !== '' &&
    typeof requirement.description === 'string' &&
    requirement.description.trim() !== '' &&
    (requirement.value === undefined || typeof requirement.value === 'string')
  );
}

function exactTokenIndex(tokens: readonly string[]): Map<string, string[]> {
  const byFirstCharacter = new Map<string, string[]>();
  for (const token of tokens) {
    const first = token[0];
    if (!first) continue;
    const entries = byFirstCharacter.get(first) ?? [];
    entries.push(token);
    byFirstCharacter.set(first, entries);
  }
  for (const entries of byFirstCharacter.values()) {
    entries.sort((left, right) => right.length - left.length || left.localeCompare(right));
  }
  return byFirstCharacter;
}

function tokenize(
  template: string,
  builtIns: ReadonlySet<BuiltInSourceMacroSyntax>,
  customSyntaxes: readonly NormalizedCustomSyntax[],
  exactTokens: readonly string[]
): {
  tokens: MacroToken[];
  diagnostics: UniversalMacroCompileDiagnostic[];
} {
  const tokens: MacroToken[] = [];
  const diagnostics: UniversalMacroCompileDiagnostic[] = [];
  const exactTokensByFirstCharacter = exactTokenIndex(exactTokens);
  const customByFirstCharacter = new Map<string, NormalizedCustomSyntax[]>();
  for (const syntax of customSyntaxes) {
    const entries = customByFirstCharacter.get(syntax.open[0] ?? '') ?? [];
    entries.push(syntax);
    entries.sort((left, right) => right.open.length - left.open.length);
    customByFirstCharacter.set(syntax.open[0] ?? '', entries);
  }
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
    const exactMatch = exactTokensByFirstCharacter
      .get(template[index] ?? '')
      ?.find(token => template.startsWith(token, index));
    if (exactMatch) {
      const end = index + exactMatch.length;
      const syntax = syntaxForExactToken(exactMatch, builtIns, customSyntaxes);
      tokens.push({
        source_token: exactMatch,
        syntax: syntax ?? 'adcp',
        start: index,
        end,
      });
      index = end;
      continue;
    }

    const customSyntax = customByFirstCharacter
      .get(template[index] ?? '')
      ?.find(syntax => template.startsWith(syntax.open, index));
    if (customSyntax) {
      appendDelimited(customSyntax.id, customSyntax.open, customSyntax.close, index + customSyntax.open.length);
      continue;
    }

    if (builtIns.has('percent') && template.startsWith('%%', index)) {
      appendDelimited('percent', '%%', '%%', index + 2);
      continue;
    }
    if (builtIns.has('dollar_brace') && template.startsWith('${', index)) {
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
    if (builtIns.has('double_brace') && template.startsWith('{{', index)) {
      appendDelimited('double_brace', '{{', '}}', index + 2);
      continue;
    }
    // Do not discover an inner single-brace macro inside an unrelated outer
    // template expression such as {{DEVICE_ID}} or ${DEVICE_ID}.
    if (!builtIns.has('double_brace') && template.startsWith('{{', index)) {
      const end = template.indexOf('}}', index + 2);
      const expressionEnd = end === -1 ? template.length : end + 2;
      const expression = template.slice(index, expressionEnd);
      if (/\{[A-Z][A-Z0-9_]*\}/.test(expression)) {
        tokens.push({ source_token: expression, syntax: 'embedded', start: index, end: expressionEnd });
      }
      index = expressionEnd;
      continue;
    }
    if (!builtIns.has('dollar_brace') && template.startsWith('${', index)) {
      const end = balancedDollarBraceEnd(template, index);
      const expressionEnd = end ?? template.length;
      const expression = template.slice(index, expressionEnd);
      if (/\{[A-Z][A-Z0-9_]*\}/.test(expression)) {
        tokens.push({ source_token: expression, syntax: 'embedded', start: index, end: expressionEnd });
      }
      index = expressionEnd;
      continue;
    }

    if (builtIns.has('bracket') && template[index] === '[') {
      // Bracket macros use upper-snake names. This deliberately excludes URL
      // array keys and IPv6 literals such as [status] and [fe80::1]. Exact
      // configured mappings can still opt into any bracket token spelling.
      let end = index + 1;
      if (/^[A-Z]$/.test(template[end] ?? '')) {
        while (/^[A-Z0-9_]$/.test(template[end] ?? '')) end += 1;
        if (template[end] === ']') {
          end += 1;
          tokens.push({ source_token: template.slice(index, end), syntax: 'bracket', start: index, end });
          index = end;
          continue;
        }
        // A colon identifies an IPv6 literal rather than a bracket macro.
        if (template[end] === ':') {
          index += 1;
          continue;
        }
        diagnostics.push({
          code: 'malformed_macro',
          severity: 'error',
          message: 'Unclosed […] macro delimiter',
          start: index,
          end: template.length,
        });
        break;
      }
    }

    // Upper-snake single-brace tokens are always surfaced because leaving one
    // in canonical_template would make the delivery translator activate it.
    if (template[index] === '{') {
      let end = index + 1;
      if (/^[A-Z]$/.test(template[end] ?? '')) {
        while (/^[A-Z0-9_]$/.test(template[end] ?? '')) end += 1;
        if (template[end] === '}') {
          end += 1;
          tokens.push({ source_token: template.slice(index, end), syntax: 'adcp', start: index, end });
          index = end;
          continue;
        }
        if (builtIns.has('adcp')) {
          diagnostics.push({
            code: 'malformed_macro',
            severity: 'error',
            message: 'Unclosed {…} macro delimiter',
            start: index,
            end: template.length,
          });
          break;
        }
      }
    }
    index += 1;
  }

  return { tokens, diagnostics };
}

/**
 * Compile an exact source-dialect mapping into canonical AdCP macros.
 * Unknown tokens remain byte-for-byte visible and make the result
 * unpublishable. Replacements are applied once and never recursively.
 */
export function compileUniversalMacroTemplate(
  input: CompileUniversalMacroTemplateInput
): CompileUniversalMacroTemplateResult {
  const diagnostics: UniversalMacroCompileDiagnostic[] = [];
  const rawInput = typeof input === 'object' && input !== null ? input : ({} as CompileUniversalMacroTemplateInput);
  const template = typeof rawInput.template === 'string' ? rawInput.template : '';
  const sourceDialect =
    typeof rawInput.source_dialect === 'string' && rawInput.source_dialect.trim() !== '' ? rawInput.source_dialect : '';
  if (typeof input !== 'object' || input === null || typeof rawInput.template !== 'string') {
    diagnostics.push({ code: 'invalid_input', severity: 'error', message: 'Template input must be a string' });
  }
  if (sourceDialect === '') {
    diagnostics.push({
      code: 'invalid_input',
      severity: 'error',
      message: 'Source dialect must be a non-empty string',
    });
  }
  const requireDocumentation =
    rawInput.require_documentation === undefined || typeof rawInput.require_documentation === 'boolean'
      ? (rawInput.require_documentation ?? true)
      : true;
  const allowCanonicalMacros =
    rawInput.allow_canonical_macros === undefined || typeof rawInput.allow_canonical_macros === 'boolean'
      ? (rawInput.allow_canonical_macros ?? false)
      : false;
  if (rawInput.require_documentation !== undefined && typeof rawInput.require_documentation !== 'boolean') {
    diagnostics.push({
      code: 'invalid_input',
      severity: 'error',
      message: 'require_documentation must be a boolean',
    });
  }
  if (rawInput.allow_canonical_macros !== undefined && typeof rawInput.allow_canonical_macros !== 'boolean') {
    diagnostics.push({
      code: 'invalid_input',
      severity: 'error',
      message: 'allow_canonical_macros must be a boolean',
    });
  }

  const enabledBuiltIns = new Set<BuiltInSourceMacroSyntax>();
  const customSyntaxes: NormalizedCustomSyntax[] = [];
  const seenCustomNames = new Set<string>();
  const seenCustomOpeners = new Set<string>();
  const sourceSyntaxes: readonly unknown[] = Array.isArray(rawInput.source_syntaxes) ? rawInput.source_syntaxes : [];
  if (sourceSyntaxes.length === 0) {
    diagnostics.push({
      code: 'source_syntax_required',
      severity: 'error',
      message: `At least one source syntax is required for ${sourceDialect || 'the selected dialect'}`,
    });
  } else {
    for (const syntax of sourceSyntaxes) {
      if (typeof syntax === 'string' && BUILT_IN_SOURCE_SYNTAXES.has(syntax as BuiltInSourceMacroSyntax)) {
        enabledBuiltIns.add(syntax as BuiltInSourceMacroSyntax);
        continue;
      }
      if (typeof syntax !== 'object' || syntax === null) {
        diagnostics.push({
          code: 'unsupported_source_syntax',
          severity: 'error',
          message: `Unsupported source macro syntax: ${String(syntax)}`,
        });
        continue;
      }
      const custom = syntax as Partial<CustomSourceMacroSyntax>;
      const validName = typeof custom.name === 'string' && /^[a-z][a-z0-9_-]*$/.test(custom.name);
      const validOpen = typeof custom.open === 'string' && custom.open.length > 0;
      const validClose = typeof custom.close === 'string' && custom.close.length > 0;
      if (
        !validName ||
        !validOpen ||
        !validClose ||
        seenCustomNames.has(custom.name as string) ||
        seenCustomOpeners.has(custom.open as string)
      ) {
        diagnostics.push({
          code: 'unsupported_source_syntax',
          severity: 'error',
          message: 'Custom source syntax requires a unique lowercase name and non-empty delimiters',
        });
        continue;
      }
      seenCustomNames.add(custom.name as string);
      seenCustomOpeners.add(custom.open as string);
      customSyntaxes.push({
        id: `custom:${custom.name}`,
        open: custom.open as string,
        close: custom.close as string,
      });
    }
  }

  const satisfiedRequirements = new Set<string>();
  const satisfactionValues: readonly unknown[] = Array.isArray(rawInput.satisfied_requirements)
    ? rawInput.satisfied_requirements
    : [];
  if (rawInput.satisfied_requirements !== undefined && !Array.isArray(rawInput.satisfied_requirements)) {
    diagnostics.push({
      code: 'invalid_requirement_satisfaction',
      severity: 'error',
      message: 'satisfied_requirements must be an array',
    });
  }
  for (const value of satisfactionValues) {
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as SourceMacroRequirementSatisfaction).kind !== 'string' ||
      (value as SourceMacroRequirementSatisfaction).kind.trim() === '' ||
      ((value as SourceMacroRequirementSatisfaction).value !== undefined &&
        typeof (value as SourceMacroRequirementSatisfaction).value !== 'string')
    ) {
      diagnostics.push({
        code: 'invalid_requirement_satisfaction',
        severity: 'error',
        message: 'Each satisfied requirement needs a non-empty kind and optional string value',
      });
      continue;
    }
    const satisfaction = value as SourceMacroRequirementSatisfaction;
    satisfiedRequirements.add(requirementKey(satisfaction));
  }

  const mappingByToken = new Map<string, MappingState>();
  const duplicateTokens = new Set<string>();
  const selectedMappings: readonly unknown[] = Array.isArray(rawInput.mappings) ? rawInput.mappings : [];
  if (!Array.isArray(rawInput.mappings)) {
    diagnostics.push({
      code: 'invalid_mapping_registry',
      severity: 'error',
      message: `Mappings for ${sourceDialect || 'the selected dialect'} must be an array`,
    });
  }
  for (const value of selectedMappings) {
    if (typeof value !== 'object' || value === null) {
      diagnostics.push({
        code: 'invalid_mapping',
        severity: 'error',
        message: `A ${sourceDialect || 'selected-dialect'} mapping is not an object`,
      });
      continue;
    }
    const mapping = value as SourceMacroMapping;
    if (typeof mapping.source_dialect !== 'string' || mapping.source_dialect.trim() === '') {
      diagnostics.push({
        code: 'invalid_mapping',
        severity: 'error',
        message: 'A mapping has no source dialect',
      });
      continue;
    }
    if (mapping.source_dialect !== sourceDialect) continue;
    if (typeof mapping.source_token !== 'string' || mapping.source_token.trim() === '') {
      diagnostics.push({
        code: 'invalid_source_token',
        severity: 'error',
        message: `A ${sourceDialect} mapping has an empty source token`,
      });
      continue;
    }
    if (mappingByToken.has(mapping.source_token)) {
      diagnostics.push({
        code: 'duplicate_mapping',
        severity: 'error',
        message: `More than one ${sourceDialect} mapping exists for ${mapping.source_token}`,
        source_token: mapping.source_token,
      });
      duplicateTokens.add(mapping.source_token);
      continue;
    }

    let valid = true;
    if (syntaxForExactToken(mapping.source_token, enabledBuiltIns, customSyntaxes) === null) {
      diagnostics.push({
        code: 'mapping_syntax_not_declared',
        severity: 'error',
        message: `Mapping for ${mapping.source_token} does not match a declared source syntax`,
        source_token: mapping.source_token,
      });
      valid = false;
    }
    if (mapping.semantic !== undefined && typeof mapping.semantic !== 'string') {
      diagnostics.push({
        code: 'invalid_mapping',
        severity: 'error',
        message: `Mapping for ${mapping.source_token} has an invalid semantic`,
        source_token: mapping.source_token,
      });
      valid = false;
    }
    if (typeof mapping.universal_macro !== 'string' || !isUniversalMacro(mapping.universal_macro)) {
      diagnostics.push({
        code: 'invalid_universal_macro',
        severity: 'error',
        message: `Mapping for ${mapping.source_token} targets an unsupported universal macro`,
        source_token: mapping.source_token,
      });
      valid = false;
    }

    const documentation = Array.isArray(mapping.documentation)
      ? mapping.documentation.filter(isValidDocumentationReference)
      : [];
    if (mapping.documentation !== undefined && !Array.isArray(mapping.documentation)) {
      diagnostics.push({
        code: 'invalid_mapping_provenance',
        severity: 'error',
        message: `Mapping for ${mapping.source_token} has invalid documentation provenance`,
        source_token: mapping.source_token,
      });
      valid = false;
    } else if (requireDocumentation && (mapping.documentation?.length ?? 0) === 0) {
      diagnostics.push({
        code: 'mapping_provenance_required',
        severity: 'error',
        message: `Mapping for ${mapping.source_token} has no documentation provenance`,
        source_token: mapping.source_token,
      });
      valid = false;
    } else if (documentation.length !== (mapping.documentation?.length ?? 0)) {
      diagnostics.push({
        code: 'invalid_mapping_provenance',
        severity: 'error',
        message: `Mapping for ${mapping.source_token} has invalid documentation provenance`,
        source_token: mapping.source_token,
      });
      valid = false;
    }

    const requirements = Array.isArray(mapping.requirements) ? mapping.requirements.filter(isValidRequirement) : [];
    if (
      (mapping.requirements !== undefined && !Array.isArray(mapping.requirements)) ||
      requirements.length !== (mapping.requirements?.length ?? 0)
    ) {
      diagnostics.push({
        code: 'invalid_mapping_requirement',
        severity: 'error',
        message: `Mapping for ${mapping.source_token} has an invalid runtime requirement`,
        source_token: mapping.source_token,
      });
      valid = false;
    }
    mappingByToken.set(mapping.source_token, { mapping, documentation, requirements, valid });
  }

  for (const token of duplicateTokens) {
    const state = mappingByToken.get(token);
    if (state) state.valid = false;
  }

  const tokenized = tokenize(template, enabledBuiltIns, customSyntaxes, [...mappingByToken.keys()]);
  diagnostics.push(...tokenized.diagnostics);

  const occurrences: UniversalMacroOccurrence[] = [];
  let canonical_template = '';
  let cursor = 0;

  for (const token of tokenized.tokens) {
    canonical_template += template.slice(cursor, token.start);
    const mappingState = mappingByToken.get(token.source_token);

    // Exact evidence-backed mappings take precedence, including when a vendor
    // token happens to have the same spelling as a canonical AdCP macro.
    if (mappingState) {
      const documentation = [...mappingState.documentation];
      const requirements = [...mappingState.requirements];
      const unmetRequirements = requirements.filter(
        requirement => !satisfiedRequirements.has(requirementKey(requirement))
      );
      if (mappingState.valid && unmetRequirements.length === 0) {
        occurrences.push({
          source_token: token.source_token,
          universal_macro: mappingState.mapping.universal_macro,
          source_dialect: sourceDialect,
          semantic: mappingState.mapping.semantic,
          syntax: token.syntax,
          status: 'mapped',
          start: token.start,
          end: token.end,
          documentation,
          requirements,
        });
        canonical_template += mappingState.mapping.universal_macro;
      } else {
        for (const requirement of unmetRequirements) {
          diagnostics.push({
            code: 'unsatisfied_requirement',
            severity: 'error',
            message: `Requirement ${requirement.kind} is not satisfied for ${token.source_token}`,
            source_token: token.source_token,
            start: token.start,
            end: token.end,
          });
        }
        occurrences.push({
          source_token: token.source_token,
          source_dialect: sourceDialect,
          semantic: mappingState.mapping.semantic,
          syntax: token.syntax,
          status: 'unresolved',
          start: token.start,
          end: token.end,
          documentation,
          requirements,
        });
        canonical_template += token.source_token;
      }
      cursor = token.end;
      continue;
    }

    if (token.syntax === 'adcp' && isUniversalMacro(token.source_token) && allowCanonicalMacros) {
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

    occurrences.push({
      source_token: token.source_token,
      source_dialect: sourceDialect,
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
      message: `No ${sourceDialect || 'selected-dialect'} mapping exists for ${token.source_token}`,
      source_token: token.source_token,
      start: token.start,
      end: token.end,
    });
    canonical_template += token.source_token;
    cursor = token.end;
  }

  canonical_template += template.slice(cursor);
  return {
    source_template: template,
    canonical_template,
    source_dialect: sourceDialect,
    occurrences,
    diagnostics,
    publishable: diagnostics.length === 0,
  };
}
