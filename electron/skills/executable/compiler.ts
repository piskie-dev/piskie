import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import ts from 'typescript';

import { getSkillsRootDir } from '../../piskiepilot/paths.js';
import { writeExecutableSkillShim } from './host-shim.js';

export interface TypeScriptDiagnostic {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

export interface CompiledSkillCandidate {
  hash: string;
  buildDir: string;
  modulePath: string;
  profile: ExecutableSkillProfile;
}

export type ExecutableSkillProfile = 'browser' | 'standard';

export interface CompileExecutableSkillOptions {
  profile?: ExecutableSkillProfile;
}

export class ExecutableSkillCompileError extends Error {
  constructor(
    message: string,
    readonly errors: readonly TypeScriptDiagnostic[],
    readonly buildDir: string,
  ) {
    super(message);
    this.name = 'ExecutableSkillCompileError';
  }
}

const BUILD_ABI = 'define-skill-v2-controlled-browser';
const DEPENDENCY_INSTALL_TIMEOUT_MS = 180_000;
const DEPENDENCY_READY_MARKER = '.dependencies-ready';
const execFileAsync = promisify(execFile);
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const BUILD_IGNORED_NAMES = new Set([
  '.git',
  '.tmp',
  '.venv',
  '__pycache__',
  'node_modules',
  'module',
]);
const BROWSER_SOURCE_ROOT_FILES = new Set(['SKILL.md', 'skill.ts']);
const BROWSER_ALLOWED_IMPORTS = new Set(['piskiepilot/core-skill']);
const BROWSER_FORBIDDEN_IDENTIFIERS = new Set([
  'BrowserManager',
  'Puppeteer',
  'CDPSession',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'require',
  'eval',
  'Function',
  'globalThis',
  'global',
  'Reflect',
  'process',
  'Deno',
  'Bun',
]);

/** Compile one immutable hash-addressed executable Skill without publishing it. */
export async function compileExecutableSkill(
  sourceDir: string,
  skillName: string,
  options: CompileExecutableSkillOptions = {},
): Promise<CompiledSkillCandidate> {
  if (!path.isAbsolute(sourceDir)) throw new Error(`sourceDir must be absolute: ${sourceDir}`);
  if (!SKILL_NAME.test(skillName)) throw new Error(`Invalid executable Skill name: ${skillName}`);

  const skillSourcePath = path.join(sourceDir, 'skill.ts');
  const skillSource = await fs.readFile(skillSourcePath, 'utf8');
  const profile = options.profile ?? detectProfile(skillSource);
  if (profile === 'browser') {
    await validateBrowserSourceLayout(sourceDir);
    const violations = validateBrowserSkillSource(skillSource, skillSourcePath);
    if (violations.length > 0) {
      throw new ExecutableSkillCompileError(
        formatDiagnostics('Browser Skill source profile rejected the build', violations),
        violations,
        sourceDir,
      );
    }
  }

  const sourceFiles = await collectSourceFiles(sourceDir);
  const hash = computeContentHash(sourceFiles, profile);
  const buildDir = path.join(getSkillsRootDir(), '.build', skillName, hash);
  const moduleDir = path.join(buildDir, 'module');
  const modulePath = path.join(moduleDir, 'skill.js');
  const completePath = path.join(buildDir, '.complete');

  const complete = await Promise.all([fs.access(completePath), fs.access(modulePath)])
    .then(() => true, () => false);
  if (complete) {
    await prepareBuildEnvironment(buildDir, profile, { reuseDependencies: true });
    return { hash, buildDir, modulePath, profile };
  }

  await fs.rm(buildDir, { recursive: true, force: true });
  try {
    await fs.mkdir(path.dirname(buildDir), { recursive: true });
    await fs.cp(sourceDir, buildDir, {
      recursive: true,
      filter(source) {
        return !BUILD_IGNORED_NAMES.has(path.basename(source));
      },
    });
    await prepareBuildEnvironment(buildDir, profile);

    const diagnostics = compileTypeScript(
      path.join(buildDir, 'skill.ts'),
      moduleDir,
      buildDir,
      profile,
    );
    if (diagnostics.length > 0) {
      throw new ExecutableSkillCompileError(
        formatDiagnostics('TypeScript compilation failed', diagnostics),
        diagnostics,
        buildDir,
      );
    }
    await fs.access(modulePath);
    await copyRuntimeAssets(buildDir, moduleDir);
    await fs.writeFile(
      path.join(moduleDir, 'package.json'),
      `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`,
      'utf8',
    );
    await fs.writeFile(completePath, `${hash}\n`, 'utf8');
    return { hash, buildDir, modulePath, profile };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    await fs.mkdir(buildDir, { recursive: true }).catch(() => undefined);
    await fs.writeFile(path.join(buildDir, '.failed'), `${message}\n`, 'utf8').catch(() => undefined);
    throw error;
  }
}

function compileTypeScript(
  skillPath: string,
  outDir: string,
  buildDir: string,
  profile: ExecutableSkillProfile,
): TypeScriptDiagnostic[] {
  const configured = profile === 'standard' ? readConfiguredCompilerOptions(buildDir) : undefined;
  if (configured?.diagnostics.length) return configured.diagnostics;
  const hostRoot = path.resolve(import.meta.dirname, '../../..');
  const compilerOptions: ts.CompilerOptions = {
    ...(configured?.options ?? {}),
    target: ts.ScriptTarget.ES2022,
    module: configured?.options.module ?? ts.ModuleKind.NodeNext,
    moduleResolution: configured?.options.moduleResolution ?? ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    esModuleInterop: true,
    forceConsistentCasingInFileNames: true,
    noFallthroughCasesInSwitch: true,
    rootDir: buildDir,
    outDir,
    noEmitOnError: true,
    noEmit: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    inlineSourceMap: false,
    emitDeclarationOnly: false,
    baseUrl: configured?.options.baseUrl ?? buildDir,
    paths: {
      ...(configured?.options.paths ?? {}),
      '@electron/*': [path.join(hostRoot, 'electron/*')],
      '@shared/*': [path.join(hostRoot, 'shared/*')],
    },
  };
  const program = ts.createProgram([skillPath], compilerOptions);
  const emit = program.emit();
  return [...ts.getPreEmitDiagnostics(program), ...emit.diagnostics]
    .filter(uniqueDiagnostic)
    .map((diagnostic) => toDiagnostic(diagnostic, buildDir));
}

function readConfiguredCompilerOptions(buildDir: string): {
  options: ts.CompilerOptions;
  diagnostics: TypeScriptDiagnostic[];
} | undefined {
  const configPath = path.join(buildDir, 'tsconfig.json');
  if (!ts.sys.fileExists(configPath)) return undefined;
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    return { options: {}, diagnostics: [toDiagnostic(config.error, buildDir)] };
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, buildDir, undefined, configPath);
  return {
    options: parsed.options,
    diagnostics: parsed.errors.map((diagnostic) => toDiagnostic(diagnostic, buildDir)),
  };
}

function uniqueDiagnostic(
  diagnostic: ts.Diagnostic,
  index: number,
  diagnostics: readonly ts.Diagnostic[],
): boolean {
  const key = diagnosticKey(diagnostic);
  return diagnostics.findIndex((candidate) => diagnosticKey(candidate) === key) === index;
}

function diagnosticKey(diagnostic: ts.Diagnostic): string {
  return `${diagnostic.file?.fileName ?? ''}:${diagnostic.start ?? -1}:${diagnostic.code}:${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
}

function toDiagnostic(diagnostic: ts.Diagnostic, rootDir: string): TypeScriptDiagnostic {
  const position = diagnostic.file && diagnostic.start !== undefined
    ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
    : undefined;
  const absoluteFile = diagnostic.file?.fileName;
  return {
    file: absoluteFile
      ? path.relative(rootDir, absoluteFile).split(path.sep).join('/')
      : 'skill.ts',
    line: (position?.line ?? 0) + 1,
    column: (position?.character ?? 0) + 1,
    code: `TS${diagnostic.code}`,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  };
}

async function prepareBuildEnvironment(
  buildDir: string,
  profile: ExecutableSkillProfile,
  options: { reuseDependencies?: boolean } = {},
): Promise<void> {
  const packagePath = path.join(buildDir, 'package.json');
  if (profile === 'browser') {
    await fs.writeFile(
      packagePath,
      `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`,
      'utf8',
    );
  } else if (!await exists(packagePath)) {
    await fs.writeFile(
      packagePath,
      `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`,
      'utf8',
    );
  } else {
    const manifest = await readPackageManifest(packagePath);
    if (
      hasDeclaredDependencies(manifest)
      && (!options.reuseDependencies || !await dependencyEnvironmentReady(buildDir, manifest))
    ) {
      await installDeclaredDependencies(buildDir);
      await fs.writeFile(path.join(buildDir, DEPENDENCY_READY_MARKER), 'ready\n', 'utf8');
    }
  }

  // The host author API is always authoritative, even when a standard Skill has npm dependencies.
  await writeExecutableSkillShim(buildDir);
}

async function readPackageManifest(packagePath: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(packagePath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid executable Skill package.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function dependencyNames(
  manifest: Record<string, unknown>,
  fields: readonly string[],
): string[] {
  return fields.flatMap((field) => {
    const value = manifest[field];
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value)
      : [];
  });
}

function hasDeclaredDependencies(manifest: Record<string, unknown>): boolean {
  const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
  return dependencyNames(manifest, dependencyFields).length > 0;
}

async function dependencyEnvironmentReady(
  buildDir: string,
  manifest: Record<string, unknown>,
): Promise<boolean> {
  if (!await exists(path.join(buildDir, DEPENDENCY_READY_MARKER))) return false;
  const required = dependencyNames(manifest, ['dependencies', 'devDependencies']);
  return (await Promise.all(required.map((name) => (
    exists(path.join(buildDir, 'node_modules', ...name.split('/'), 'package.json'))
  )))).every(Boolean);
}

async function installDeclaredDependencies(buildDir: string): Promise<void> {

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    await execFileAsync(npm, ['install', '--no-audit', '--no-fund'], {
      cwd: buildDir,
      timeout: DEPENDENCY_INSTALL_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, CI: '1' },
    });
  } catch (error) {
    const detail = error && typeof error === 'object'
      ? String((error as { stderr?: unknown; message?: unknown }).stderr
        ?? (error as { message?: unknown }).message
        ?? error)
      : String(error);
    throw new Error(`Executable Skill dependency install failed: ${detail.trim()}`);
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export function validateBrowserSkillSource(
  source: string,
  fileName = 'skill.ts',
): TypeScriptDiagnostic[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics: TypeScriptDiagnostic[] = [];
  const report = (node: ts.Node, code: string, message: string): void => {
    const position = file.getLineAndCharacterOfPosition(node.getStart(file));
    diagnostics.push({
      file: path.basename(fileName),
      line: position.line + 1,
      column: position.character + 1,
      code,
      message,
    });
  };

  if (/@ts-(?:ignore|nocheck|expect-error)\b/u.test(source)) {
    report(file, 'BSP1008', 'Browser Skill cannot suppress TypeScript diagnostics');
  }
  if (/^\s*\/\/\/\s*<reference\b/mu.test(source)) {
    report(file, 'BSP1010', 'Browser Skill does not allow triple-slash references; references/ is documentation only');
  }

  const validateModuleSpecifier = (moduleSpecifier: ts.Expression): void => {
    if (!ts.isStringLiteral(moduleSpecifier)) return;
    const moduleName = moduleSpecifier.text;
    if (!BROWSER_ALLOWED_IMPORTS.has(moduleName)) {
      report(
        moduleSpecifier,
        'BSP1001',
        `Browser Skill imports are limited to ${[...BROWSER_ALLOWED_IMPORTS].join(', ')}; received ${JSON.stringify(moduleName)}`,
      );
    }
  };

  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      validateModuleSpecifier(statement.moduleSpecifier);
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      validateModuleSpecifier(statement.moduleSpecifier);
    }
    if (ts.isImportEqualsDeclaration(statement)) {
      report(statement, 'BSP1002', 'Browser Skill does not allow import-equals or require imports');
    }
  }

  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      report(
        node,
        'BSP1011',
        'Browser Skill does not allow explicit any types; keep the generated SDK type surface intact',
      );
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      report(node, 'BSP1003', 'Browser Skill does not allow dynamic import()');
    }
    if (
      (ts.isAsExpression(node) && !isConstAssertion(node))
      || ts.isTypeAssertionExpression(node)
    ) {
      report(node, 'BSP1009', 'Browser Skill does not allow type assertions; validate data instead of bypassing the SDK type surface');
    }
    if (ts.isIdentifier(node) && BROWSER_FORBIDDEN_IDENTIFIERS.has(node.text)) {
      report(node, 'BSP1004', `Browser Skill cannot access ${node.text}`);
    }
    if (isUidIdentifier(node)) {
      report(node, 'BSP1005', 'Snapshot UID cannot be stored, accepted, or returned by skill.ts');
    }
    if (ts.isStringLiteralLike(node)) {
      if (/^\d+_\d+$/u.test(node.text.trim())) {
        report(node, 'BSP1006', 'Snapshot UID literals are ephemeral and cannot be written to skill.ts');
      }
      if (/\b(?:puppeteer|chrome-devtools|browsermanager|cdp)\b/iu.test(node.text)) {
        report(node, 'BSP1007', 'Browser Skill cannot use Puppeteer, CDP, BrowserManager, or chrome-devtools APIs');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return deduplicateDiagnostics(diagnostics);
}

function isConstAssertion(node: ts.AsExpression): boolean {
  return ts.isTypeReferenceNode(node.type)
    && ts.isIdentifier(node.type.typeName)
    && node.type.typeName.text === 'const';
}

function isUidIdentifier(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return hasUidComponent(node.text);
  if (ts.isStringLiteralLike(node) && isPropertyNameNode(node.parent)) {
    return hasUidComponent(node.text);
  }
  return false;
}

function hasUidComponent(value: string): boolean {
  return /(?:^|_)uids?(?:$|_)/iu.test(value) || /(?:Uid|UID)s?$/u.test(value);
}

function isPropertyNameNode(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isParameter(parent))
    && parent.name === node
  );
}

function deduplicateDiagnostics(diagnostics: TypeScriptDiagnostic[]): TypeScriptDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.line}:${diagnostic.column}:${diagnostic.code}:${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function validateBrowserSourceLayout(sourceDir: string): Promise<void> {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (BROWSER_SOURCE_ROOT_FILES.has(entry.name)) continue;
    if (entry.name === 'references' && entry.isDirectory()) continue;
    throw new Error(
      `Browser Skill source supports only SKILL.md, skill.ts, and optional references/: ${entry.name}`,
    );
  }
}

function detectProfile(source: string): ExecutableSkillProfile {
  const file = ts.createSourceFile('skill.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let browser = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node)
      && ((ts.isIdentifier(node.name) && node.name.text === 'domain')
        || (ts.isStringLiteralLike(node.name) && node.name.text === 'domain'))
      && ts.isStringLiteralLike(node.initializer)
      && node.initializer.text === 'browser'
    ) {
      browser = true;
    }
    if (!browser) ts.forEachChild(node, visit);
  };
  visit(file);
  return browser ? 'browser' : 'standard';
}

type SourceFile = Readonly<{ relativePath: string; content: Buffer }>;

async function collectSourceFiles(root: string, dir = root): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (BUILD_IGNORED_NAMES.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Executable Skill source cannot contain symlinks: ${absolute}`);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push({
        relativePath: path.relative(root, absolute).split(path.sep).join('/'),
        content: await fs.readFile(absolute),
      });
    }
  }
  return files;
}

function computeContentHash(files: readonly SourceFile[], profile: ExecutableSkillProfile): string {
  const hash = crypto.createHash('sha256');
  hash.update(BUILD_ABI);
  hash.update(profile);
  for (const file of files) {
    hash.update('\0');
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(String(file.content.length));
    hash.update('\0');
    hash.update(file.content);
  }
  return hash.digest('hex');
}

async function copyRuntimeAssets(buildDir: string, moduleDir: string): Promise<void> {
  await fs.mkdir(moduleDir, { recursive: true });
  const entries = await fs.readdir(buildDir, { withFileTypes: true });
  for (const entry of entries) {
    if (BUILD_IGNORED_NAMES.has(entry.name) || entry.name === 'package.json') continue;
    if (entry.name.endsWith('.ts') || entry.name === 'tsconfig.json') continue;
    await fs.cp(path.join(buildDir, entry.name), path.join(moduleDir, entry.name), {
      recursive: entry.isDirectory(),
      force: true,
    });
  }
}

function formatDiagnostics(title: string, diagnostics: readonly TypeScriptDiagnostic[]): string {
  return [
    `${title} (${diagnostics.length} issue${diagnostics.length === 1 ? '' : 's'}):`,
    ...diagnostics.map(
      (diagnostic) => `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.code} ${diagnostic.message}`,
    ),
  ].join('\n');
}
