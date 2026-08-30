#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@typescript-eslint/parser';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
const SOURCE_ROOT = join(PROJECT_ROOT, 'src');
const IGNORE_TOKEN = 'i18n-ignore';

const PRESENTATION_NAMES = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'body',
  'caption',
  'description',
  'emptytext',
  'helptext',
  'hint',
  'label',
  'message',
  'oktext',
  'canceltext',
  'placeholder',
  'subtitle',
  'title',
  'tooltip',
]);

const PRESENTATION_SINKS = new Set([
  'alert',
  'confirm',
  'flashErr',
  'flashOk',
  'flashWarn',
  'onFlash',
  'prompt',
  'setActionError',
  'setError',
  'setFault',
  'setNotice',
  'setQueryError',
  'setStartError',
]);

// These are product names, schema identifiers, protocols, platforms, or units.
const TECHNICAL_LITERALS = new Set([
  'API',
  'Authorization',
  'Electron',
  'FPS',
  'HTTP',
  'HTTPS',
  'ID',
  'LLM',
  'MCP',
  'Piskie',
  'SOCKS5',
  'User-Agent',
  'Windows',
  'call id',
  'code:',
  'data',
  'encrypted content',
  'image',
  'macOS',
  'main',
  'name',
  'npx',
  'openai_reasoning',
  'piskie',
  'provider item',
  'redacted_thinking',
  'requestId:',
  'signature',
  'status',
  'text',
  'thinking',
  'tok',
  'tokens',
  'tool_use',
  'type:',
  'v',
  'Linux',
  'ms',
  'tool_result · error',
  'tool_result · success',
  'unknown ·',
  '· v',
]);

const NON_PRODUCT_CATALOG_OWNERS = new Map([
  ['src/features/envstudio/data/siteAtlas.ts', new Set(['SITE_NAMES'])],
  ['src/features/imdossier/data/channel-facts.ts', new Set(['marks'])],
  ['src/features/prefdeck/data/vendor-atlas.ts', new Set(['AI_ATLAS', 'IMAGE_ATLAS'])],
  ['src/features/prefdeck/forge/ModelForge.tsx', new Set(['TRANSPORT_CHOICES'])],
]);

function normalizedPath(filePath) {
  return filePath.replaceAll('\\', '/');
}

function sourceRelativePath(filePath) {
  const normalized = normalizedPath(filePath);
  const marker = '/src/';
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex >= 0) return normalized.slice(markerIndex + 1);
  return normalized.startsWith('src/') ? normalized : normalized.split('/').at(-1) ?? normalized;
}

function propertyName(node) {
  if (!node || node.computed) return undefined;
  if (node.key?.type === 'Identifier') return node.key.name;
  if (node.key?.type === 'Literal' && typeof node.key.value === 'string') return node.key.value;
  return undefined;
}

function jsxAttributeName(node) {
  if (node.name?.type === 'JSXIdentifier') return node.name.name;
  return undefined;
}

function isPresentationName(name) {
  if (!name) return false;
  const normalized = name.toLowerCase();
  if (PRESENTATION_NAMES.has(normalized)) return true;
  return normalized.endsWith('label')
    || normalized.endsWith('placeholder')
    || normalized.endsWith('tooltip');
}

function calleeName(node) {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'MemberExpression' && !node.computed) {
    return node.property?.type === 'Identifier' ? node.property.name : undefined;
  }
  return undefined;
}

function assignedName(node) {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type !== 'MemberExpression') return undefined;
  if (!node.computed && node.property?.type === 'Identifier') return node.property.name;
  if (node.computed && node.property?.type === 'Literal' && typeof node.property.value === 'string') {
    return node.property.value;
  }
  return undefined;
}

function containsCjk(text) {
  return /[\u3400-\u9fff]/u.test(text);
}

function containsLetters(text) {
  return /\p{L}/u.test(text);
}

function compactText(text) {
  return text.replace(/\s+/gu, ' ').trim();
}

function isPathProtocolOrCode(text) {
  if (/^(?:https?|file|piskie-attachment):\/\/\S*$/iu.test(text)) return true;
  if (/^(?:\.{0,2}[\\/]|[\\/#][^\s]+|[A-Za-z]:[\\/])\S*$/u.test(text)) return true;
  if (/^(?:[\w-]+\.)+(?:ai|app|cn|com|dev|io|net|org)(?::\d+)?(?:\/\S*)?$/iu.test(text)) return true;
  if (/^@[a-z0-9_.-]+\/[a-z0-9_.-]+(?:@\S+)?$/iu.test(text)) return true;
  if (/^-[a-z]\s+@[a-z0-9_.-]+\/[a-z0-9_.-]+(?:@\S+)?$/iu.test(text)) return true;
  if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/u.test(text)) return true;
  return false;
}

function isTechnicalLiteral(text) {
  const compact = compactText(text);
  return TECHNICAL_LITERALS.has(compact) || isPathProtocolOrCode(compact);
}

function isNonProductCatalogLiteral(filePath, ancestors) {
  const owners = NON_PRODUCT_CATALOG_OWNERS.get(sourceRelativePath(filePath));
  if (!owners) return false;
  return ancestors.some((ancestor) => (
    ancestor.type === 'VariableDeclarator'
    && ancestor.id?.type === 'Identifier'
    && owners.has(ancestor.id.name)
  ));
}

function renderedLiteralNodes(node, output = []) {
  if (!node) return output;
  if (node.type === 'Literal' && typeof node.value === 'string') {
    output.push({ node, text: node.value });
    return output;
  }
  if (node.type === 'TemplateLiteral') {
    for (const quasi of node.quasis) output.push({ node: quasi, text: quasi.value.raw });
    return output;
  }
  if (node.type === 'ConditionalExpression') {
    renderedLiteralNodes(node.consequent, output);
    renderedLiteralNodes(node.alternate, output);
    return output;
  }
  if (node.type === 'LogicalExpression') {
    renderedLiteralNodes(node.right, output);
    return output;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    renderedLiteralNodes(node.left, output);
    renderedLiteralNodes(node.right, output);
    return output;
  }
  if (node.type === 'ArrayExpression') {
    for (const element of node.elements) renderedLiteralNodes(element, output);
    return output;
  }
  if (node.type === 'SequenceExpression') {
    renderedLiteralNodes(node.expressions.at(-1), output);
    return output;
  }
  if (node.type === 'TSAsExpression'
    || node.type === 'TSTypeAssertion'
    || node.type === 'TSNonNullExpression'
    || node.type === 'ChainExpression') {
    renderedLiteralNodes(node.expression, output);
  }
  return output;
}

function collectFiles(directory, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || normalizedPath(filePath).endsWith('/src/i18n/locales')) continue;
      collectFiles(filePath, output);
      continue;
    }
    if (!entry.name.match(/\.(?:ts|tsx)$/u)) continue;
    if (entry.name.match(/\.(?:test|spec)\.(?:ts|tsx)$/u)) continue;
    output.push(filePath);
  }
  return output;
}

export function checkSource(source, filePath = 'src/fixture.tsx') {
  let ast;
  try {
    ast = parse(source, {
      comment: true,
      ecmaVersion: 'latest',
      ecmaFeatures: { jsx: filePath.endsWith('.tsx') },
      loc: true,
      range: true,
      sourceType: 'module',
    });
  } catch (error) {
    return [{
      filePath,
      line: error.lineNumber ?? 1,
      column: error.column ?? 1,
      kind: 'parse-error',
      text: error.message,
    }];
  }

  const comments = ast.comments ?? [];
  const directives = comments
    .filter((comment) => comment.value.includes(IGNORE_TOKEN))
    .map((comment) => ({
      comment,
      valid: new RegExp(`\\b${IGNORE_TOKEN}\\s*--\\s*\\S.+`, 'u').test(comment.value),
      used: false,
    }));
  const violations = [];
  const reported = new Set();

  for (const directive of directives) {
    if (directive.valid) continue;
    violations.push({
      filePath,
      line: directive.comment.loc.start.line,
      column: directive.comment.loc.start.column + 1,
      kind: 'invalid-ignore',
      text: `${IGNORE_TOKEN} requires a reason after "--"`,
    });
  }

  function matchingDirective(node) {
    const startLine = node.loc.start.line;
    const match = directives.find((directive) => directive.valid && (
      directive.comment.loc.start.line === startLine
      || directive.comment.loc.end.line === startLine - 1
    ));
    if (match) match.used = true;
    return match;
  }

  function report(node, kind, text) {
    const compact = compactText(text);
    if (!compact || !containsLetters(compact)) return;
    const key = `${node.range?.[0] ?? node.loc.start.line}:${node.range?.[1] ?? node.loc.end.line}`;
    if (reported.has(key)) return;
    if (matchingDirective(node)) return;
    reported.add(key);
    violations.push({
      filePath,
      line: node.loc.start.line,
      column: node.loc.start.column + 1,
      kind,
      text: compact,
    });
  }

  function reportVisible(node, kind, text) {
    if (isTechnicalLiteral(text)) return;
    report(node, kind, text);
  }

  function visit(node, ancestors = []) {
    if (!node || typeof node !== 'object') return;
    const parent = ancestors.at(-1);

    if (node.type === 'JSXText') {
      reportVisible(node, 'jsx-text', node.value);
    }

    if (node.type === 'JSXAttribute' && isPresentationName(jsxAttributeName(node))) {
      if (node.value?.type === 'Literal' && typeof node.value.value === 'string') {
        reportVisible(node.value, 'visible-attribute', node.value.value);
      } else if (node.value?.type === 'JSXExpressionContainer') {
        for (const literal of renderedLiteralNodes(node.value.expression)) {
          reportVisible(literal.node, 'visible-attribute', literal.text);
        }
      }
    }

    if (node.type === 'JSXExpressionContainer' && parent?.type !== 'JSXAttribute') {
      for (const literal of renderedLiteralNodes(node.expression)) {
        reportVisible(literal.node, 'jsx-expression', literal.text);
      }
    }

    if (node.type === 'Property'
      && isPresentationName(propertyName(node))
      && !isNonProductCatalogLiteral(filePath, ancestors)) {
      for (const literal of renderedLiteralNodes(node.value)) {
        reportVisible(literal.node, 'presentation-field', literal.text);
      }
    }

    if (node.type === 'VariableDeclarator'
      && node.id?.type === 'Identifier'
      && isPresentationName(node.id.name)) {
      for (const literal of renderedLiteralNodes(node.init)) {
        reportVisible(literal.node, 'presentation-variable', literal.text);
      }
    }

    if ((node.type === 'AssignmentExpression' || node.type === 'AssignmentPattern')
      && isPresentationName(assignedName(node.left))) {
      for (const literal of renderedLiteralNodes(node.right)) {
        reportVisible(literal.node, 'presentation-assignment', literal.text);
      }
    }

    if (node.type === 'CallExpression') {
      const name = calleeName(node.callee);
      if (name === 'rawText') {
        for (const literal of renderedLiteralNodes(node.arguments[0])) {
          report(literal.node, 'literal-raw-text', literal.text);
        }
      } else if (name && PRESENTATION_SINKS.has(name)) {
        for (const literal of renderedLiteralNodes(node.arguments[0])) {
          reportVisible(literal.node, 'presentation-call', literal.text);
        }
      }
    }

    if (node.type === 'Literal'
      && typeof node.value === 'string'
      && containsCjk(node.value)
      && !isNonProductCatalogLiteral(filePath, ancestors)) {
      report(node, 'cjk-literal', node.value);
    }

    if (node.type === 'TemplateElement'
      && containsCjk(node.value.raw)
      && !isNonProductCatalogLiteral(filePath, ancestors)) {
      report(node, 'cjk-literal', node.value.raw);
    }

    const nextAncestors = [...ancestors, node];
    for (const [key, value] of Object.entries(node)) {
      if (key === 'comments' || key === 'loc' || key === 'range' || key === 'tokens') continue;
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child?.type) visit(child, nextAncestors);
        }
      } else if (value?.type) {
        visit(value, nextAncestors);
      }
    }
  }

  visit(ast);

  for (const directive of directives) {
    if (!directive.valid || directive.used) continue;
    violations.push({
      filePath,
      line: directive.comment.loc.start.line,
      column: directive.comment.loc.start.column + 1,
      kind: 'unused-ignore',
      text: `unused ${IGNORE_TOKEN}`,
    });
  }

  return violations.sort((left, right) => left.line - right.line || left.column - right.column);
}

export function checkProject(sourceRoot = SOURCE_ROOT) {
  const violations = [];
  for (const filePath of collectFiles(sourceRoot)) {
    const source = readFileSync(filePath, 'utf8');
    violations.push(...checkSource(source, filePath));
  }
  return violations;
}

function run() {
  const violations = checkProject();
  if (violations.length === 0) {
    console.log('i18n literal check passed (zero baseline)');
    return;
  }

  for (const violation of violations) {
    const displayPath = relative(PROJECT_ROOT, violation.filePath) || violation.filePath;
    console.error(
      `${displayPath}:${violation.line}:${violation.column}  ${violation.kind}: ${JSON.stringify(violation.text)}`,
    );
  }
  console.error(
    `\nMove product copy into src/i18n/locales. For non-product literals, add `
      + `// ${IGNORE_TOKEN} -- <reason> next to the literal.`,
  );
  process.exitCode = 1;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) run();
