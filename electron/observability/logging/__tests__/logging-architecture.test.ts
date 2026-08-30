import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SOURCE_ROOTS = ['electron', 'shared', 'src'];
const LOG_METHODS = new Set(['debug', 'info', 'warn', 'error']);
const EVENT_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,4}$/;
const IMPLEMENTATION_SEGMENT =
  /(?:^|_)(?:application|service|manager|controller|router|interceptor|pipeline|port|component|index|host)$/;
const FORBIDDEN_CONTEXT_FIELDS = new Set([
  'cost',
  'data',
  'details',
  'elapsed',
  'elapsedMs',
  'entityId',
  'error',
  'errorMessage',
  'latency',
  'message',
  'meta',
  'metadata',
  'stack',
  'totalAgents',
  'value',
]);

interface LogCall {
  readonly file: string;
  readonly line: number;
  readonly level: string;
  readonly event: string;
  readonly message: string;
  readonly scope: string;
}

describe('logging, runtime profile, and identifier architecture', () => {
  it('keeps UUID and runtime decisions behind their owners', () => {
    const files = productionFiles();
    expect(files.filter((file) => source(file).includes('randomUUID'))).toEqual([
      'shared/utils/identifiers.ts',
    ]);
    for (const token of [
      'NODE_ENV',
      'PISKIE_LOG_LEVEL',
      'PISKIE_RENDERER_URL',
    ]) {
      expect(
        files.filter((file) => source(file).includes(token)),
        token
      ).toEqual(['electron/bootstrap/runtime-profile.ts']);
    }

    const forbiddenTokens = [
      'isDevMode',
      'PISKIE_DEV_MODE',
      '--dev-mode',
      'getRendererUrl',
      'generateFlowId',
      'generateId',
      'generateShortId',
      'electron/utils/diagnostics',
      'electron/utils/env',
      'electron/utils/id',
      'electron/utils/logger',
    ];
    const violations: string[] = [];
    for (const file of files) {
      const text = source(file);
      for (const token of forbiddenTokens) {
        if (text.includes(token)) violations.push(`${file}: ${token}`);
      }
    }
    expect(violations).toEqual([]);

    for (const removed of ['diagnostics.ts', 'env.ts', 'id.ts', 'logger.ts']) {
      expect(fs.existsSync(path.join(ROOT, 'electron/utils', removed)), removed).toBe(false);
    }
  });

  it('confines Winston to the JSONL sink', () => {
    const consumers = productionFiles().filter((file) => /from ['"]winston['"]/.test(source(file)));
    expect(consumers).toEqual(['electron/observability/logging/winston-jsonl-sink.ts']);
    expect(source('electron/observability/logging/app-log.ts')).not.toMatch(
      /(?:node:fs|from ['"]electron['"]|from ['"]winston['"])/
    );
  });

  it('uses static, bounded, and stable application log records', () => {
    const violations: string[] = [];
    const calls: LogCall[] = [];
    for (const file of productionFiles()) inspectLogCalls(file, calls, violations);

    const signatures = new Map<string, string>();
    for (const call of calls) {
      const signature = `${call.level}|${call.scope}|${call.message}`;
      const prior = signatures.get(call.event);
      if (prior && prior !== signature) {
        violations.push(
          `${call.file}:${call.line}: ${call.event} changed from ${prior} to ${signature}`
        );
      } else {
        signatures.set(call.event, signature);
      }
    }

    expect(calls.length).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});

function inspectLogCalls(file: string, calls: LogCall[], violations: string[]): void {
  const text = source(file);
  if (!text.includes('appLog')) return;
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const childScopes = new Map<string, string>();

  const discoverChild = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      isMethodCall(node.initializer, 'appLog', 'child')
    ) {
      const scope = staticObjectString(node.initializer.arguments[0], 'scope');
      if (scope) childScopes.set(node.name.text, scope);
      else report(node, file, violations, 'child logger requires a static scope');
    }
    ts.forEachChild(node, discoverChild);
  };
  discoverChild(tree);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression;
      const method = node.expression.name.text;
      if (
        ts.isIdentifier(receiver) &&
        LOG_METHODS.has(method) &&
        (receiver.text === 'appLog' || childScopes.has(receiver.text))
      ) {
        inspectLogCall(node, file, method, childScopes.get(receiver.text), calls, violations);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
}

function inspectLogCall(
  call: ts.CallExpression,
  file: string,
  level: string,
  childScope: string | undefined,
  calls: LogCall[],
  violations: string[]
): void {
  const record = call.arguments[0];
  if (!record || !ts.isObjectLiteralExpression(record)) {
    report(call, file, violations, 'log call requires one object-literal record');
    return;
  }
  const event = staticObjectString(record, 'event');
  const message = staticObjectString(record, 'message');
  const context = objectProperty(record, 'context');
  const scope = childScope ?? staticObjectString(context, 'scope');

  if (!event) report(call, file, violations, 'event must be a static string');
  else if (!EVENT_PATTERN.test(event)) report(call, file, violations, `invalid event ${event}`);
  else if (event.includes('.operation.')) report(call, file, violations, `generic event ${event}`);
  else if (event.split('.').some((segment) => IMPLEMENTATION_SEGMENT.test(segment))) {
    report(call, file, violations, `implementation-shaped event ${event}`);
  }

  if (!message) report(call, file, violations, 'message must be a static string');
  else if (!/^[\x20-\x7e]{1,80}$/.test(message)) {
    report(call, file, violations, 'message must contain 1-80 ASCII characters');
  } else if (
    /%[sdifoOj%]/.test(message) ||
    /^\[[^\]]+\]/.test(message) ||
    /successfully/i.test(message) ||
    message.includes(':') ||
    message.endsWith('.')
  ) {
    report(call, file, violations, `non-canonical message ${JSON.stringify(message)}`);
  }

  if (!scope) report(call, file, violations, 'log record requires a static scope');
  else if (scope.split('.').some((segment) => IMPLEMENTATION_SEGMENT.test(segment))) {
    report(call, file, violations, `implementation-shaped scope ${scope}`);
  }
  if (context && !ts.isObjectLiteralExpression(context)) {
    report(context, file, violations, 'context must be an object literal');
  } else if (context) {
    const fields = context.properties.filter((property) => {
      const name = propertyName(property);
      return name !== undefined && name !== 'scope';
    });
    if (fields.length > 12) report(context, file, violations, 'context exceeds 12 fields');
    for (const property of context.properties) {
      if (ts.isSpreadAssignment(property)) {
        if (!isSafeConditionalObjectSpread(property.expression)) {
          report(property, file, violations, 'context may not spread opaque values');
        }
        continue;
      }
      const name = propertyName(property);
      if (!name || name === 'scope') continue;
      if (!/^[a-z][A-Za-z0-9]*$/.test(name)) {
        report(property, file, violations, `invalid context field ${name}`);
      }
      if (FORBIDDEN_CONTEXT_FIELDS.has(name)) {
        report(property, file, violations, `generic context field ${name}`);
      }
    }
  }

  if (event && message && scope) {
    calls.push({ file, line: lineOf(call, call.getSourceFile()), level, event, message, scope });
  }
}

function isSafeConditionalObjectSpread(expression: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expression)) {
    return isSafeConditionalObjectSpread(expression.expression);
  }
  return (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
    ts.isObjectLiteralExpression(expression.right)
  );
}

function productionFiles(): string[] {
  const files: string[] = [];
  const visit = (relative: string): void => {
    const absolute = path.join(ROOT, relative);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (['__tests__', 'testing', 'vendor', 'dist', 'dist-electron'].includes(entry.name))
          continue;
        visit(child);
      } else if (/\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
        files.push(child);
      }
    }
  };
  for (const root of SOURCE_ROOTS) visit(root);
  return files.sort();
}

function objectProperty(value: ts.Expression | undefined, name: string): ts.Expression | undefined {
  if (!value || !ts.isObjectLiteralExpression(value)) return undefined;
  const property = value.properties.find((candidate) => propertyName(candidate) === name);
  return property && ts.isPropertyAssignment(property) ? property.initializer : undefined;
}

function staticObjectString(value: ts.Expression | undefined, name: string): string | undefined {
  const property = objectProperty(value, name);
  return property && ts.isStringLiteral(property) ? property.text : undefined;
}

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  if (!property.name) return undefined;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    return property.name.text;
  return undefined;
}

function isMethodCall(call: ts.CallExpression, receiver: string, method: string): boolean {
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === receiver &&
    call.expression.name.text === method
  );
}

function report(node: ts.Node, file: string, violations: string[], message: string): void {
  violations.push(`${file}:${lineOf(node, node.getSourceFile())}: ${message}`);
}

function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function scriptKind(file: string): ts.ScriptKind {
  return file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function source(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}
